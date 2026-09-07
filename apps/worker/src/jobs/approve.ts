// Auto-approve (§8.5).
//
// The human version of this job is Morten reading an email in /queue and
// clicking Approve. This is the same sequence with nobody in the chair, and it
// exists because the queue was the only place in the pipeline where work
// stopped until a person happened to be at a laptop.
//
// What it does NOT relax. Every gate the manual path runs, this runs, in the
// same order and for the same reasons:
//
//   1. the proof must still be in the queue          listQueue
//   2. the copy lint must pass, re-run here rather   renderSend
//      than trusted from generation (§9.2.8)
//   3. the address must not have been suppressed     isSuppressed
//      since the proof was built
//   4. contact-once is decided by                    sends_email_hash_uniq
//      the index, not by this code (§3.2)
//
// And the four gates it never reaches are untouched: the campaign's paused
// flag, the warmup cap, the pacing window and PROBE_SEND_ENABLED all live at
// dispatch, so an approved row is still only a row. The single thing removed
// is the pair of eyes on the copy, which is why the switch is a line in
// probe.toml that defaults to off.
//
// One deliberate difference from the manual path: when the scheduler cannot
// find a day with capacity inside the horizon, a human is told and the row is
// written anyway, because a human asked for it. Here the proof is left in the
// queue instead. Nobody is watching the warning, and a proof left alone is
// picked up by the next pass once warmup or the cap has room.

import { newToken } from '@probe/core';
import {
  ContactedAlreadyError,
  createSend,
  dropLead,
  isSuppressed,
  listQueue,
  setLeadStatus,
  type QueueItem,
} from '@probe/db';
import { loadConfig, logger } from '@probe/config';
import { describeLint, renderSend } from '../send/render';
import { approver, baseUrl, postalAddress } from '../send/runtime';
import { planSlot } from '../send/plan';
import type { ApproveSummary } from '../types';

const log = logger('job.approve');

/** How many proofs one pass will approve. A launch morning that produced two
 *  hundred findings is a reason to look at the queue, not to write two hundred
 *  send rows in one tick; the rest wait for the next pass. */
export const DEFAULT_APPROVE_LIMIT = 50;

export interface AutoApproveOptions {
  /** Run even when auto_approve is false in probe.toml. `cli approve --yes`. */
  force?: boolean;
  limit?: number;
  now?: Date;
}

export async function runAutoApprove(options: AutoApproveOptions = {}): Promise<ApproveSummary> {
  const cfg = loadConfig();
  const summary: ApproveSummary = {
    considered: 0,
    approved: 0,
    lint_failed: 0,
    suppressed: 0,
    contacted_other_campaign: 0,
    no_capacity: 0,
    failed: 0,
    disabled: false,
  };

  if (!cfg.global.auto_approve && !options.force) {
    summary.disabled = true;
    return summary;
  }

  const limit = Math.max(1, options.limit ?? DEFAULT_APPROVE_LIMIT);
  const items = await listQueue(limit);
  summary.considered = items.length;
  if (items.length === 0) return summary;

  const approvedBy = `auto:${approver()}`;

  for (const item of items) {
    try {
      const outcome = await approveOne(item, {
        approvedBy,
        now: options.now ?? new Date(),
        global: cfg.global,
      });
      summary[outcome] += 1;
    } catch (err) {
      // One bad proof must not strand the rest of the queue. The proof stays
      // ready, so the next pass tries it again.
      summary.failed += 1;
      log.error('auto-approval threw', {
        proof_id: item.proof.id,
        lead: item.lead.domain,
        error: err instanceof Error ? (err.stack ?? err.message) : String(err),
      });
    }
  }

  log.info('auto-approve pass finished', { ...summary });
  return summary;
}

type ApproveOutcome =
  | 'approved'
  | 'lint_failed'
  | 'suppressed'
  | 'contacted_other_campaign'
  | 'no_capacity';

/**
 * One proof, through the same four gates as §8.5, in the same order.
 *
 * The tokens are minted once and used for both the lint and the send row, so
 * the message the lint passed is the message the row will render.
 */
async function approveOne(
  item: QueueItem,
  ctx: { approvedBy: string; now: Date; global: ReturnType<typeof loadConfig>['global'] },
): Promise<ApproveOutcome> {
  const { proof, lead, campaign, contact } = item;
  const tokens = { unsub: newToken(), click: newToken() };

  const rendered = renderSend({
    proof,
    lead,
    campaign,
    contact,
    unsubToken: tokens.unsub,
    clickToken: tokens.click,
    baseUrl: baseUrl(),
    postalAddress: postalAddress(),
  });

  if (!rendered.lint.ok) {
    // Left in the queue on purpose. A lint failure is a generator bug or a
    // placeholder postal address, and both are fixed by changing something and
    // re-running, not by dropping the lead.
    log.warn('auto-approval refused by copy lint', {
      proof_id: proof.id,
      lead: lead.domain,
      violations: describeLint(rendered.lint),
    });
    return 'lint_failed';
  }

  if (await isSuppressed(contact.email_hash)) {
    await dropLead(lead.id, 'suppressed');
    log.warn('auto-approval refused, address suppressed since generation', {
      proof_id: proof.id,
      lead: lead.domain,
    });
    return 'suppressed';
  }

  const plan = await planSlot({ campaign, now: ctx.now, global: ctx.global });
  if (plan.overCapacity) {
    log.info('no capacity inside the scheduling horizon, leaving the proof queued', {
      proof_id: proof.id,
      lead: lead.domain,
      campaign: campaign.slug,
      warmup_start: campaign.warmup_start ? String(campaign.warmup_start) : null,
      daily_cap: campaign.daily_cap,
    });
    return 'no_capacity';
  }

  try {
    await createSend({
      proof_id: proof.id,
      campaign_id: campaign.id,
      contact_id: contact.id,
      email_hash: contact.email_hash,
      approved_by: ctx.approvedBy,
      scheduled_for: plan.scheduledFor,
      unsub_token: tokens.unsub,
      click_token: tokens.click,
    });
  } catch (err) {
    if (err instanceof ContactedAlreadyError) {
      // §3.2 is enforced by the index, so this is the expected path.
      await dropLead(lead.id, 'contacted_other_campaign');
      log.info('lead dropped, address already carries a live send', {
        proof_id: proof.id,
        lead: lead.domain,
      });
      return 'contacted_other_campaign';
    }
    throw err;
  }

  await setLeadStatus(lead.id, 'approved', campaign.id);

  log.info('proof auto-approved', {
    proof_id: proof.id,
    lead: lead.domain,
    campaign: campaign.slug,
    scheduled_for: plan.scheduledFor.toISOString(),
    approved_by: ctx.approvedBy,
  });

  return 'approved';
}
