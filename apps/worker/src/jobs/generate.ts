// Generate, 07:30 and every ten minutes through the morning (§6, §8.4).
//
// One pass does two things: it starts generator work for leads that have a
// contact, and it polls the work that is already running. Both halves end in
// the same place, applyOutcome, so there is exactly one mapping from a
// generator response to a database transition and it can be read in one screen.

import {
  callGenerator,
  newToken,
  type GeneratorOutcome,
  type GeneratorRequest,
} from '@probe/core';
import {
  createProof,
  dropLead,
  duePendingProofs,
  getCampaign,
  getContactForLead,
  getLead,
  getProofForLead,
  isSuppressed,
  listLeadsByStatus,
  markProofAttempt,
  markProofFailed,
  markProofNoProof,
  markProofReady,
  setLeadStatus,
  type CampaignRow,
  type ContactRow,
  type LeadRow,
  type LeadStatus,
  type ProofRow,
} from '@probe/db';
import { loadConfig, loadEnv, logger } from '@probe/config';
import { describeLint, renderSend } from '../send/render';
import { baseUrl, postalAddress } from '../send/runtime';
import type { GenerateSummary } from '../types';

const log = logger('job.generate');

// ---------------------------------------------------------------------------
// Bounded concurrency
// ---------------------------------------------------------------------------

/**
 * Runs `fn` over `items` with at most `limit` in flight, preserving output
 * order. Concurrency is capped at generator_concurrency (3) so exit1's probe
 * infrastructure is not hammered by exit1's own outreach tool (§8.4): the
 * generator spends 60 to 90 minutes probing a stranger's site per lead, and
 * twenty of those at once is a self-inflicted outage.
 *
 * Small enough to own rather than depend on.
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const width = Math.max(1, Math.floor(limit));
  const results = new Array<R>(items.length);
  let cursor = 0;
  let firstError: unknown = null;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      try {
        results[index] = await fn(items[index], index);
      } catch (err) {
        // Keep the other workers going and surface the first failure once
        // everything has drained. A half-finished pass with dangling promises
        // is worse than a slow one.
        if (firstError === null) firstError = err;
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(width, items.length) }, worker));
  if (firstError !== null) throw firstError;
  return results;
}

// ---------------------------------------------------------------------------
// Outcome to database transition
// ---------------------------------------------------------------------------

/** Every write applyOutcome makes. Injectable so the mapping can be tested
 *  against fakes without a database. */
export interface GenerateDeps {
  markProofReady(
    id: string,
    p: {
      subject: string;
      html: string;
      text_body: string;
      fix: string;
      severity: number;
      evidence_url: string;
      meta: Record<string, unknown>;
    },
  ): Promise<void>;
  markProofNoProof(id: string, detail?: string): Promise<void>;
  markProofFailed(id: string, error: string): Promise<void>;
  markProofAttempt(
    id: string,
    patch: {
      attempts?: number;
      polls?: number;
      next_poll_at?: Date | null;
      first_requested_at?: Date | null;
      error?: string | null;
    },
  ): Promise<void>;
  setLeadStatus(id: string, status: LeadStatus, campaignId?: string | null): Promise<void>;
  dropLead(id: string, reason: string, status?: LeadStatus): Promise<void>;
}

export const dbGenerateDeps: GenerateDeps = {
  markProofReady,
  markProofNoProof,
  markProofFailed,
  markProofAttempt,
  setLeadStatus,
  dropLead,
};

export type OutcomeEffect =
  | { effect: 'ready' }
  | { effect: 'lint_failed'; detail: string }
  | { effect: 'pending'; nextPollAt: Date; polls: number }
  | { effect: 'no_proof' }
  | { effect: 'budget_exhausted'; elapsedMs: number }
  | { effect: 'retry'; attempts: number; nextPollAt: Date }
  | { effect: 'failed'; attempts: number; error: string };

export interface OutcomeContext {
  outcome: GeneratorOutcome;
  proof: ProofRow;
  lead: LeadRow;
  campaign: CampaignRow;
  contact: ContactRow;
  now: Date;
  budgetMs: number;
  maxAttempts: number;
  baseUrl: string;
  postalAddress: string;
  deps?: GenerateDeps;
}

/** Errors back off before the next attempt. The re-poll cron runs every ten
 *  minutes, so the schedule lives in next_poll_at rather than in a sleep. */
export function errorBackoffMs(attempts: number): number {
  return Math.min(15 * 60_000, 60_000 * 2 ** Math.max(0, attempts - 1));
}

/** True when the elapsed-time budget has run out. §6: the budget is elapsed
 *  time, not poll count, and it is two hours, sized so the exit1 probe run of
 *  60 to 90 minutes finishes with headroom. Shortening it would start
 *  discarding findings that were about to arrive. */
export function budgetExhausted(firstRequestedAt: Date | null, now: Date, budgetMs: number): boolean {
  if (!firstRequestedAt) return false;
  return now.getTime() - firstRequestedAt.getTime() > budgetMs;
}

export async function applyOutcome(ctx: OutcomeContext): Promise<OutcomeEffect> {
  const deps = ctx.deps ?? dbGenerateDeps;
  const { outcome, proof, lead } = ctx;

  switch (outcome.kind) {
    case 'ready': {
      const body = outcome.body;

      // Lint at generation time as well as in the harness and at approval
      // (§9.2.8). A generator that drifted salesy overnight is then visible at
      // 07:30, in a log line, instead of at 09:00 when Morten opens the queue
      // and finds it full of things he cannot approve.
      //
      // The tokens here are throwaway. The real unsub and click tokens are
      // minted when the send row is written at approval; all the lint needs is
      // a well-formed set of three links.
      const candidate: ProofRow = {
        ...proof,
        subject: body.subject,
        html: body.html,
        text_body: body.text,
        fix: body.fix,
        severity: body.severity,
        evidence_url: body.evidence_url,
        meta: body.meta ?? {},
        status: 'ready',
      };
      const rendered = renderSend({
        proof: candidate,
        lead,
        campaign: ctx.campaign,
        contact: ctx.contact,
        unsubToken: newToken(),
        clickToken: newToken(),
        baseUrl: ctx.baseUrl,
        postalAddress: ctx.postalAddress,
      });

      if (!rendered.lint.ok) {
        const detail = describeLint(rendered.lint);
        await deps.markProofFailed(proof.id, `copy lint failed: ${detail}`);
        await deps.dropLead(lead.id, 'generator_failed');
        log.error('generator output failed the copy lint', {
          leadId: lead.id,
          proofId: proof.id,
          detail,
        });
        return { effect: 'lint_failed', detail };
      }

      await deps.markProofReady(proof.id, {
        subject: body.subject,
        html: body.html,
        text_body: body.text,
        fix: body.fix,
        severity: body.severity,
        evidence_url: body.evidence_url,
        meta: body.meta ?? {},
      });
      await deps.setLeadStatus(lead.id, 'ready');
      log.info('proof ready', { leadId: lead.id, proofId: proof.id, severity: body.severity });
      return { effect: 'ready' };
    }

    case 'pending': {
      const firstRequestedAt = proof.first_requested_at;
      if (budgetExhausted(firstRequestedAt, ctx.now, ctx.budgetMs)) {
        const elapsedMs = ctx.now.getTime() - (firstRequestedAt as Date).getTime();
        const error = `generator still pending after ${Math.round(elapsedMs / 60_000)} minutes`;
        await deps.markProofFailed(proof.id, error);
        await deps.dropLead(lead.id, 'generator_failed');
        log.warn('generator budget exhausted', { leadId: lead.id, proofId: proof.id, elapsedMs });
        return { effect: 'budget_exhausted', elapsedMs };
      }

      const polls = proof.polls + 1;
      const nextPollAt = new Date(ctx.now.getTime() + outcome.retryAfterMs);
      await deps.markProofAttempt(proof.id, {
        polls,
        next_poll_at: nextPollAt,
        // Set on the first request only. Overwriting it on every poll would
        // reset the elapsed-time budget forever and turn two hours into never.
        ...(firstRequestedAt ? {} : { first_requested_at: ctx.now }),
      });
      log.debug('generator pending', { leadId: lead.id, proofId: proof.id, polls, nextPollAt });
      return { effect: 'pending', nextPollAt, polls };
    }

    case 'no_proof': {
      // Not an error, and the majority outcome by design (§6, §15.4). A clean
      // site is the expected case and the whole premise is that we say nothing
      // when we have nothing. Logged at info; a warn here would train the
      // operator to ignore warns.
      await deps.markProofNoProof(proof.id, 'generator returned no finding above the severity bar');
      await deps.dropLead(lead.id, 'no_proof');
      log.info('no proof', { leadId: lead.id, proofId: proof.id });
      return { effect: 'no_proof' };
    }

    case 'error': {
      const attempts = proof.attempts + 1;
      const error = outcome.status
        ? `generator returned ${outcome.status}: ${outcome.message}`
        : outcome.message;

      if (attempts >= ctx.maxAttempts) {
        await deps.markProofFailed(proof.id, `${error} (attempt ${attempts})`);
        await deps.dropLead(lead.id, 'generator_failed');
        log.warn('generator failed, attempts exhausted', {
          leadId: lead.id,
          proofId: proof.id,
          attempts,
          error,
        });
        return { effect: 'failed', attempts, error };
      }

      const nextPollAt = new Date(ctx.now.getTime() + errorBackoffMs(attempts));
      await deps.markProofAttempt(proof.id, {
        attempts,
        error,
        next_poll_at: nextPollAt,
        ...(proof.first_requested_at ? {} : { first_requested_at: ctx.now }),
      });
      log.warn('generator error, backing off', {
        leadId: lead.id,
        proofId: proof.id,
        attempts,
        nextPollAt,
        error,
      });
      return { effect: 'retry', attempts, nextPollAt };
    }
  }
}

// ---------------------------------------------------------------------------
// The pass
// ---------------------------------------------------------------------------

interface WorkItem {
  proof: ProofRow;
  lead: LeadRow;
  campaign: CampaignRow;
  contact: ContactRow;
  /** True for a lead being started this pass, false for a poll of work that
   *  was already running. Only affects logging. */
  fresh: boolean;
}

/** Builds the §6 request. */
export function buildGeneratorRequest(lead: LeadRow, contact: ContactRow): GeneratorRequest {
  return {
    lead_id: lead.id,
    product: {
      name: lead.name,
      url: lead.url,
      description: lead.description,
      source: lead.source_id,
      launched_at: lead.launched_at ? lead.launched_at.toISOString() : null,
      tags: lead.tags,
    },
    // §6: `recipient` carries only first_name. The email address is never put
    // on this wire, so a generator bug cannot leak contact data. Assert it by
    // construction: `contact` is in scope here and `contact.email` is
    // deliberately not read.
    recipient: { first_name: contact.first_name },
  };
}

const START_BATCH_LIMIT = 200;
const POLL_BATCH_LIMIT = 200;

export async function runGenerate(): Promise<GenerateSummary> {
  const cfg = loadConfig();
  const env = loadEnv();
  const now = new Date();

  const summary: GenerateSummary = { considered: 0, ready: 0, pending: 0, no_proof: 0, failed: 0 };

  const items: WorkItem[] = [];
  const seenProofs = new Set<string>();

  // ---- A. Start new work -------------------------------------------------
  const fresh = await listLeadsByStatus('contact_resolved', START_BATCH_LIMIT);
  for (const lead of fresh) {
    if (!lead.campaign_id) {
      log.warn('contact_resolved lead has no campaign, skipping', { leadId: lead.id });
      continue;
    }
    const contact = await getContactForLead(lead.id);
    if (!contact) {
      log.warn('contact_resolved lead has no contact row, skipping', { leadId: lead.id });
      continue;
    }

    // Suppression, checked again before a generator call is spent. §7 checks
    // it independently at three points and this is the second: hours have
    // passed since resolution and an unsubscribe may have landed in between.
    if (await isSuppressed(contact.email_hash)) {
      await dropLead(lead.id, 'suppressed');
      log.info('lead suppressed before generation', { leadId: lead.id });
      continue;
    }

    const campaign = await getCampaign(lead.campaign_id);
    if (!campaign) {
      log.warn('lead points at a campaign that does not exist', {
        leadId: lead.id,
        campaignId: lead.campaign_id,
      });
      continue;
    }

    // proofs_lead_uniq means one proof per lead. A retry of this job must
    // reuse the existing row rather than colliding on the index.
    const proof =
      (await getProofForLead(lead.id)) ??
      (await createProof({ lead_id: lead.id, campaign_id: campaign.id }));
    await setLeadStatus(lead.id, 'generating');

    if (seenProofs.has(proof.id)) continue;
    seenProofs.add(proof.id);
    items.push({ proof, lead, campaign, contact, fresh: true });
  }

  // ---- B. Poll pending work ----------------------------------------------
  const pending = await duePendingProofs(now, POLL_BATCH_LIMIT);
  for (const proof of pending) {
    if (seenProofs.has(proof.id)) continue;
    const lead = await getLead(proof.lead_id);
    const campaign = await getCampaign(proof.campaign_id);
    const contact = lead ? await getContactForLead(lead.id) : null;
    if (!lead || !campaign || !contact) {
      log.warn('pending proof is missing its lead, campaign or contact', { proofId: proof.id });
      continue;
    }
    seenProofs.add(proof.id);
    items.push({ proof, lead, campaign, contact, fresh: false });
  }

  summary.considered = items.length;
  if (items.length === 0) {
    log.info('generate: nothing to do');
    return summary;
  }

  const base = baseUrl();
  const postal = postalAddress();

  const effects = await mapLimit(items, cfg.global.generator_concurrency, async (item) => {
    try {
      return await processItem(item, {
        secret: env.PROBE_HMAC_SECRET,
        timeoutMs: cfg.global.generator_timeout_ms,
        minSeverity: cfg.global.generator_min_severity,
        budgetMs: cfg.global.generator_budget_ms,
        maxAttempts: cfg.global.generator_max_attempts,
        baseUrl: base,
        postalAddress: postal,
        now,
      });
    } catch (err) {
      // One lead blowing up must not take the pass with it. The proof stays
      // pending and the next re-poll picks it up.
      log.error('generate item threw', {
        leadId: item.lead.id,
        proofId: item.proof.id,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  });

  for (const effect of effects) {
    if (!effect) {
      summary.failed += 1;
      continue;
    }
    switch (effect.effect) {
      case 'ready':
        summary.ready += 1;
        break;
      case 'pending':
      case 'retry':
        summary.pending += 1;
        break;
      case 'no_proof':
        summary.no_proof += 1;
        break;
      case 'lint_failed':
      case 'budget_exhausted':
      case 'failed':
        summary.failed += 1;
        break;
    }
  }

  log.info('generate complete', { ...summary });
  return summary;
}

async function processItem(
  item: WorkItem,
  opts: {
    secret: string;
    timeoutMs: number;
    minSeverity: number;
    budgetMs: number;
    maxAttempts: number;
    baseUrl: string;
    postalAddress: string;
    now: Date;
  },
): Promise<OutcomeEffect> {
  const { proof, lead, campaign, contact } = item;

  // Check the elapsed-time budget before spending the call, not only after the
  // response comes back. A proof that has been pending for two hours is done
  // whatever the generator would have said.
  if (budgetExhausted(proof.first_requested_at, opts.now, opts.budgetMs)) {
    return applyOutcome({
      outcome: { kind: 'pending', retryAfterMs: 0 },
      proof,
      lead,
      campaign,
      contact,
      now: opts.now,
      budgetMs: opts.budgetMs,
      maxAttempts: opts.maxAttempts,
      baseUrl: opts.baseUrl,
      postalAddress: opts.postalAddress,
    });
  }

  const outcome = await callGenerator({
    url: campaign.generator_url,
    secret: opts.secret,
    request: buildGeneratorRequest(lead, contact),
    timeoutMs: opts.timeoutMs,
    minSeverity: opts.minSeverity,
  });

  return applyOutcome({
    outcome,
    proof,
    lead,
    campaign,
    contact,
    now: new Date(),
    budgetMs: opts.budgetMs,
    maxAttempts: opts.maxAttempts,
    baseUrl: opts.baseUrl,
    postalAddress: opts.postalAddress,
  });
}

/**
 * One lead, generated to a conclusion, blocking until there is one.
 *
 * `cli smoke` uses this. runGenerate is built for a cron: it starts work,
 * records next_poll_at and returns, leaving the polling to the next tick. Run
 * by hand outside the re-poll window that is a trap, because the elapsed-time
 * budget keeps running while nothing polls, so the work expires unattended.
 * Here the caller is a person watching a terminal, so the poll loop lives in
 * the process instead of in cron.
 *
 * Identical work either way: the same processItem, the same applyOutcome, the
 * same budget. Only the schedule differs.
 */
export async function generateForLead(
  leadId: string,
  onProgress?: (message: string) => void,
): Promise<OutcomeEffect> {
  const cfg = loadConfig();
  const env = loadEnv();
  const say = onProgress ?? ((): void => {});

  const lead = await getLead(leadId);
  if (!lead) throw new Error(`no lead with id ${leadId}`);
  if (!lead.campaign_id) throw new Error(`lead ${lead.domain} has no campaign`);
  const campaign = await getCampaign(lead.campaign_id);
  if (!campaign) throw new Error(`lead ${lead.domain} points at a campaign that does not exist`);
  const contact = await getContactForLead(lead.id);
  if (!contact) throw new Error(`lead ${lead.domain} has no contact row`);

  if (await isSuppressed(contact.email_hash)) {
    await dropLead(lead.id, 'suppressed');
    throw new Error('that address is suppressed, permanently and by design');
  }

  const proof =
    (await getProofForLead(lead.id)) ??
    (await createProof({ lead_id: lead.id, campaign_id: campaign.id }));
  await setLeadStatus(lead.id, 'generating');

  const started = Date.now();
  for (;;) {
    const current = (await getProofForLead(lead.id)) ?? proof;
    const effect = await processItem(
      { proof: current, lead, campaign, contact, fresh: false },
      {
        secret: env.PROBE_HMAC_SECRET,
        timeoutMs: cfg.global.generator_timeout_ms,
        minSeverity: cfg.global.generator_min_severity,
        budgetMs: cfg.global.generator_budget_ms,
        maxAttempts: cfg.global.generator_max_attempts,
        baseUrl: baseUrl(),
        postalAddress: postalAddress(),
        now: new Date(),
      },
    );

    if (effect.effect !== 'pending' && effect.effect !== 'retry') return effect;

    // next_poll_at is the generator's own retry_after, clamped to 60s at the
    // low end, so this is its pace and not ours.
    const waitMs = Math.max(5_000, effect.nextPollAt.getTime() - Date.now());
    const elapsedMin = Math.round((Date.now() - started) / 60_000);
    say(
      `still working, ${elapsedMin} min elapsed, next check in ${Math.round(waitMs / 1000)}s` +
        ` (the exit1 probe takes 60 to 90 minutes)`,
    );
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
}
