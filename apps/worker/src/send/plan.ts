// The worker's view of the shared slot planner.
//
// The walk itself is planSendSlot in @probe/core, for the same reason the
// composer lives there: apps/web places a row when a human approves in /queue
// and the worker places one when auto-approval is on, and the two cannot be
// allowed to disagree about which day a send lands on. All this file does is
// fetch the two numbers the walk needs from the database.

import { planSendSlot, type SlotPlan } from '@probe/core';
import { listSends, sentTodayCount, type CampaignRow } from '@probe/db';
import type { GlobalConfig } from '@probe/config';

export type { SlotPlan };

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

  return planSendSlot({
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
}
