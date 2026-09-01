// One pacing loop per sending subdomain (§5.4, §8.6).
//
// exit1.dev and day3.app are separate reputations on separate SES identities.
// One loop for both would let a backlog on one queue starve the other and
// would compute one gap from two different remaining quotas, so the loops are
// independent and each derives its pace from its own campaign's numbers.
//
// Every iteration re-checks every gate. None of them is hoisted out of the
// loop as an optimisation: PROBE_SEND_ENABLED, the paused flag and the
// suppression list are all things a human or a webhook changes while the
// daemon is running, and a gate read once at boot is not a kill switch.

import {
  computeGapMs,
  dailyCap,
  inSendWindow,
  windowBounds,
  type LintViolation,
} from '@probe/core';
import {
  cancelSend,
  claimNextDueSend,
  getCampaign,
  getContactForLead,
  getLead,
  getProof,
  insertEvent,
  isSuppressed,
  markSendFailed,
  markSendSent,
  releaseSend,
  sentTodayCount,
  setLeadStatus,
  type CampaignRow,
  type SendRow,
} from '@probe/db';
import { loadConfig, logger, type ProbeConfig } from '@probe/config';
import { describeLint, renderSend } from './render';
import { baseUrl, postalAddress, sendEnabled } from './runtime';
import type { SendReceipt, Sender } from './sender';

const log = logger('send.loop');

/** What one iteration did, and by implication how long to wait next. */
export type IterationOutcome =
  | { kind: 'disabled' }
  | { kind: 'missing_campaign'; campaignId: string }
  | { kind: 'out_of_window'; nextStart: Date }
  | { kind: 'paused' }
  | { kind: 'cap_reached'; sentToday: number; cap: number }
  | { kind: 'idle' }
  | { kind: 'cancelled'; sendId: string; reason: string }
  | { kind: 'lint_failed'; sendId: string; violations: LintViolation[] }
  | { kind: 'failed'; sendId: string; error: string }
  | { kind: 'sent'; sendId: string; providerEmailId: string; gapMs: number };

export interface IterationArgs {
  campaignId: string;
  sender: Sender;
  now?: Date;
}

/**
 * Exactly one pass of the §8.6 gate sequence for one campaign. Returns rather
 * than sleeping, so the same function serves the daemon, the one-shot CLI and
 * the tests.
 */
export async function sendIteration(args: IterationArgs): Promise<IterationOutcome> {
  const cfg = loadConfig();
  const now = args.now ?? new Date();

  // Gate 1. The global kill switch, re-read from the environment on every
  // iteration. Reading it once at boot would mean PROBE_SEND_ENABLED=false
  // plus a restart is the only way to stop, and the restart would be the part
  // doing the work. This way the flag itself is the switch (§5.5).
  if (!sendEnabled()) return { kind: 'disabled' };

  const campaign = await getCampaign(args.campaignId);
  if (!campaign) return { kind: 'missing_campaign', campaignId: args.campaignId };

  // Gate 2. Weekdays, 09:00 to 16:00 in the campaign's timezone (§5.4).
  const inWindow = inSendWindow({
    now,
    timezone: campaign.timezone,
    sendDays: cfg.global.send_days,
    window: cfg.global.send_window,
  });
  if (!inWindow) {
    return {
      kind: 'out_of_window',
      nextStart: nextWindowStart(
        now,
        campaign.timezone,
        cfg.global.send_days,
        cfg.global.send_window,
      ),
    };
  }

  // Gate 3. Paused, re-read from the table. The big red button in the UI
  // writes there and nowhere else (§5.5), and auto-pause writes there too, so
  // an in-memory copy would ignore both.
  if (campaign.paused) return { kind: 'paused' };

  // Gate 4. The warmup curve. dailyCap is min(curve for the day, daily_cap)
  // and is 0 before warmup_start is set, so a campaign that has never been
  // started sends nothing even with rows queued.
  const cap = dailyCap({
    warmupStart: campaign.warmup_start,
    campaignDailyCap: campaign.daily_cap,
    now,
    timezone: campaign.timezone,
  });
  const sentToday = await sentTodayCount(campaign.id, campaign.timezone, now);
  if (sentToday >= cap) return { kind: 'cap_reached', sentToday, cap };

  // Gate 5. Claim a row, by flipping it to 'sending' in one atomic UPDATE.
  //
  // The claim has to be the mutation, not a lock. A lock released when its
  // transaction commits leaves the row still 'queued' with nothing marking it
  // as taken, and the window between that and the provider accepting the
  // message is wide enough for a second process to claim the same row and send
  // it too. sends_email_hash_uniq cannot catch that: the row already exists.
  // See claimNextDueSend.
  const send = await claimNextDueSend(campaign.id, now);
  if (!send) return { kind: 'idle' };

  // Everything past the claim runs inside this try so an unexpected throw
  // cannot strand the row in 'sending', where it would hold a contact-once slot
  // and never be dispatched. Every gate below resolves the row deliberately;
  // this only catches what none of them expected.
  try {
    return await dispatchClaimed({ send, campaign, cap, sentToday, cfg, sender: args.sender });
  } catch (err) {
    await releaseSend(send.id);
    throw err;
  }
}

interface DispatchArgs {
  send: SendRow;
  campaign: CampaignRow;
  cap: number;
  sentToday: number;
  cfg: ProbeConfig;
  sender: Sender;
}

/**
 * Gates 6 to 9, for a row that is already claimed and therefore already off the
 * queue. Every exit either resolves the row (sent / failed / cancelled) or
 * throws, and the caller releases it on a throw.
 */
async function dispatchClaimed(args: DispatchArgs): Promise<IterationOutcome> {
  const { send, campaign, cap, sentToday, cfg } = args;

  // Gate 6. Suppression, immediately before dispatch and not a moment earlier.
  // Hours pass between approval and this line, and an unsubscribe or a reply
  // that arrived in between has to win (§8.6, §7 third checkpoint).
  // Cancelling rather than failing releases the contact slot and consumes no
  // quota: nothing was sent.
  if (await isSuppressed(send.email_hash)) {
    await cancelSend(send.id, 'suppressed at dispatch');
    log.info('send cancelled, suppressed at dispatch', { sendId: send.id });
    return { kind: 'cancelled', sendId: send.id, reason: 'suppressed at dispatch' };
  }

  const proof = await getProof(send.proof_id);
  if (!proof) {
    await markSendFailed(send.id, `proof ${send.proof_id} is missing`);
    return { kind: 'failed', sendId: send.id, error: 'proof missing' };
  }
  const lead = await getLead(proof.lead_id);
  if (!lead) {
    await markSendFailed(send.id, `lead ${proof.lead_id} is missing`);
    return { kind: 'failed', sendId: send.id, error: 'lead missing' };
  }
  const contact = await getContactForLead(proof.lead_id);
  // The hash on the send row is the one that passed the contact-once index and
  // the suppression check. If the contact row no longer matches it, the
  // address in hand is not the address that was approved, and guessing is not
  // an option.
  if (!contact || contact.email_hash !== send.email_hash) {
    await markSendFailed(send.id, 'contact row does not match the approved email hash');
    return { kind: 'failed', sendId: send.id, error: 'contact hash mismatch' };
  }
  if (!contact.email) {
    // Scrubbed by a suppression insert (§9.3). Cancel, do not fail: there is
    // nothing transient about it and the slot should go back.
    await cancelSend(send.id, 'contact address scrubbed');
    return { kind: 'cancelled', sendId: send.id, reason: 'contact address scrubbed' };
  }

  const rendered = renderSend({
    proof,
    lead,
    campaign,
    contact,
    unsubToken: send.unsub_token,
    clickToken: send.click_token,
    baseUrl: baseUrl(),
    postalAddress: postalAddress(),
  });

  // Gate 7. A failing email cannot be sent, in exactly the same way it cannot
  // be approved (§8.5). The generator may have been redeployed between
  // approval and now; the lint is what notices.
  if (!rendered.lint.ok) {
    const detail = describeLint(rendered.lint);
    await markSendFailed(send.id, `copy lint failed: ${detail}`);
    log.error('send refused, copy lint failed', { sendId: send.id, detail });
    return { kind: 'lint_failed', sendId: send.id, violations: rendered.lint.violations };
  }

  // Gate 8. Dispatch. The send id is the provider's idempotency key, so an
  // ambiguous timeout is safe for the client to retry: Day3 replays the
  // original response rather than accepting a second message for the same
  // founder. That is the second half of contact-once, the first being the
  // atomic claim above (§3.2).
  let receipt: SendReceipt;
  try {
    receipt = await args.sender.send(
      {
        fromName: campaign.from_name,
        fromEmail: campaign.from_email,
        replyTo: campaign.reply_to ?? undefined,
        to: contact.email,
        subject: rendered.message.subject,
        html: rendered.message.html,
        text: rendered.message.text,
        unsubscribeUrl: rendered.message.unsubscribeUrl,
        mime: rendered.mime,
      },
      { sendId: send.id, campaignSlug: campaign.slug },
    );
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    // The partial unique index means a failed row releases the contact slot,
    // so a transient provider error cannot burn a contact forever (§7). Nothing
    // here re-holds it; that is the database's job and it already did it.
    await markSendFailed(send.id, error);
    log.error('send failed', { sendId: send.id, error });
    return { kind: 'failed', sendId: send.id, error };
  }

  // Guarded on 'sending', so only the process that claimed this row completes
  // it. A false return means something else already resolved the row (the boot
  // reconciliation, most likely) and this dispatch raced it: the message went
  // out, so say so loudly rather than pretending it did not.
  const completed = await markSendSent(send.id, {
    providerEmailId: receipt.providerEmailId,
    provider: receipt.provider,
  });
  if (!completed) {
    log.error('send was dispatched but the row had already been resolved elsewhere', {
      sendId: send.id,
      providerEmailId: receipt.providerEmailId,
    });
  }
  await insertEvent({
    send_id: send.id,
    type: 'send',
    detail: { provider: receipt.provider, provider_email_id: receipt.providerEmailId },
  });
  // The lead reaches its terminal status here and nowhere else. Without this the
  // lead sits at 'approved' forever and the `sent` filter on /leads is dead UI.
  await setLeadStatus(lead.id, 'sent');
  log.info('sent', {
    sendId: send.id,
    campaign: campaign.slug,
    provider: receipt.provider,
    providerEmailId: receipt.providerEmailId,
  });

  // Gate 9. The gap is computed, never a fixed range. A fixed 4 to 22 minute
  // range averages 13 minutes, fits about 32 sends in a seven hour window, and
  // can therefore never reach a 35 or 50 per day cap (§5.4). Remaining window
  // divided by remaining quota reaches the cap by construction and spreads an
  // early warmup day's 5 sends across the whole window instead of clustering
  // them in the first hour.
  const after = new Date();
  const bounds = windowBounds({
    now: after,
    timezone: campaign.timezone,
    window: cfg.global.send_window,
  });
  const gapMs = computeGapMs({
    remainingWindowMs: Math.max(0, bounds.end.getTime() - after.getTime()),
    remainingQuota: Math.max(0, cap - (sentToday + 1)),
    gapFloorMinutes: cfg.global.gap_floor_minutes,
    jitter: cfg.global.gap_jitter,
  });

  return { kind: 'sent', sendId: send.id, providerEmailId: receipt.providerEmailId, gapMs };
}

/** Distinct sending subdomain of a campaign's from_email. The unit of
 *  reputation, and therefore the unit of pacing (§5.4). */
export function sendingDomain(campaign: CampaignRow): string {
  const at = campaign.from_email.lastIndexOf('@');
  return at === -1
    ? campaign.from_email.toLowerCase()
    : campaign.from_email.slice(at + 1).toLowerCase();
}

/** Groups campaigns by sending subdomain, preserving config order. */
export function groupBySendingDomain(campaigns: CampaignRow[]): Map<string, CampaignRow[]> {
  const groups = new Map<string, CampaignRow[]>();
  for (const c of campaigns) {
    const domain = sendingDomain(c);
    const bucket = groups.get(domain);
    if (bucket) bucket.push(c);
    else groups.set(domain, [c]);
  }
  return groups;
}

/**
 * The next instant the window opens, so an out-of-window loop sleeps instead
 * of spinning. Walks forward a day at a time because the send-day list skips
 * weekends and the window is defined in local time, where a DST change moves
 * the absolute instant.
 */
export function nextWindowStart(
  now: Date,
  timezone: string,
  sendDays: string[],
  window: [string, string],
): Date {
  for (let day = 0; day <= 8; day++) {
    const probe = new Date(now.getTime() + day * 24 * 60 * 60 * 1000);
    const bounds = windowBounds({ now: probe, timezone, window });
    if (bounds.start.getTime() <= now.getTime()) continue;
    // One second in, so an exclusive boundary in inSendWindow cannot make this
    // loop skip a perfectly good day.
    const probeInside = new Date(bounds.start.getTime() + 1000);
    if (inSendWindow({ now: probeInside, timezone, sendDays, window })) return bounds.start;
  }
  // Should be unreachable with any sane send_days. An hour is a safe beat.
  return new Date(now.getTime() + 60 * 60 * 1000);
}

/** How long to wait after an iteration that did not send. Short enough that a
 *  kill switch or an unpause is noticed quickly, long enough not to hammer
 *  Postgres with an empty queue. */
export const IDLE_BEAT_MS = 30_000;
export const BLOCKED_BEAT_MS = 60_000;
export const CAP_BEAT_MS = 5 * 60_000;
/** Longest single sleep. Chunking a nine hour overnight wait keeps SIGTERM
 *  responsive without a second timer. */
export const MAX_SLEEP_MS = 5 * 60_000;

export function beatFor(outcome: IterationOutcome): number {
  switch (outcome.kind) {
    case 'sent':
      return outcome.gapMs;
    case 'idle':
      return IDLE_BEAT_MS;
    case 'cap_reached':
      return CAP_BEAT_MS;
    case 'out_of_window':
      return Math.max(1_000, outcome.nextStart.getTime() - Date.now());
    case 'disabled':
    case 'paused':
    case 'missing_campaign':
      return BLOCKED_BEAT_MS;
    // A cancel, a lint refusal or an SES error consumed no quota and left the
    // queue shorter. Take the next row after a short breath rather than
    // sitting out a full gap.
    case 'cancelled':
    case 'lint_failed':
    case 'failed':
      return 1_000;
  }
}

/** Sleep that wakes early when the daemon is stopping. */
export function sleepUntil(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, Math.min(ms, MAX_SLEEP_MS));
    signal.addEventListener('abort', finish, { once: true });
  });
}

/**
 * One subdomain's loop. Campaigns sharing a subdomain take turns, so neither
 * one inside a shared reputation starves the other either.
 */
export async function runPacingLoop(args: {
  domain: string;
  campaignIds: string[];
  sender: Sender;
  signal: AbortSignal;
}): Promise<void> {
  const { domain, campaignIds, sender, signal } = args;
  const loopLog = log.child({ domain });
  loopLog.info('pacing loop started', { campaigns: campaignIds.length });

  let cursor = 0;
  while (!signal.aborted) {
    const campaignId = campaignIds[cursor % campaignIds.length];
    cursor += 1;

    let outcome: IterationOutcome;
    try {
      outcome = await sendIteration({ campaignId, sender });
    } catch (err) {
      // A dead database connection must not kill the loop. Back off and try
      // again; systemd restarting the process would not fix it any faster.
      const error = err instanceof Error ? err.message : String(err);
      loopLog.error('iteration threw', { campaignId, error });
      await sleepUntil(BLOCKED_BEAT_MS, signal);
      continue;
    }

    let waitMs = beatFor(outcome);
    // With several campaigns on one subdomain the turn taking already spaces
    // things out, so do not also sleep a full beat per campaign.
    if (campaignIds.length > 1 && outcome.kind !== 'sent') waitMs = Math.min(waitMs, IDLE_BEAT_MS);

    loopLog.debug('iteration', { campaignId, outcome: outcome.kind, waitMs });
    await sleepUntil(waitMs, signal);
  }

  loopLog.info('pacing loop stopped');
}
