import { planSendSlot, type SlotPlan } from '@probe/core';
import { listSends, sentTodayCount } from '@probe/db';
import type { CampaignRow } from '@probe/db';
import type { GlobalConfig } from '@probe/config';
import { logger } from '@probe/config';

const log = logger('web:schedule');

export type { SlotPlan };

/**
 * Pick scheduled_for for a newly approved send (§8.5, §5.4).
 *
 * The walk itself is planSendSlot in @probe/core, so this app and the worker's
 * auto-approver place a row on the same day for the same reasons. All that is
 * left here is the pair of database reads it needs: what is already queued for
 * this campaign, and what has already gone out today.
 */
export async function planSlot(args: {
  campaign: CampaignRow;
  now: Date;
  global: GlobalConfig;
}): Promise<SlotPlan> {
  const { campaign, now, global } = args;
  const timezone = campaign.timezone || global.timezone;

  const queued = await listSends({
    campaignId: campaign.id,
    status: 'queued',
    limit: 1000,
  });
  const queuedAt = queued
    .map((s) => new Date(s.scheduled_for).getTime())
    .filter((t) => Number.isFinite(t));

  const sentToday = await sentTodayCount(campaign.id, timezone, now);

  const plan = planSendSlot({
    now,
    timezone,
    sendDays: global.send_days,
    window: global.send_window,
    gapFloorMinutes: global.gap_floor_minutes,
    jitter: global.gap_jitter,
    warmupStart: campaign.warmup_start,
    campaignDailyCap: campaign.daily_cap,
    queuedAt,
    sentToday,
  });

  if (plan.overCapacity) {
    // Not a refusal: the row is still written at the fallback slot, and the
    // send daemon re-checks the cap and the kill switch before every dispatch,
    // so a row parked here can never turn into an unpaced send.
    log.warn('no capacity inside the scheduling horizon', {
      campaign: campaign.slug,
      warmup_start: campaign.warmup_start ? String(campaign.warmup_start) : null,
      daily_cap: campaign.daily_cap,
    });
  }

  return plan;
}
