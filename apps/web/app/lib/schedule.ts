import { dailyCap, inSendWindow, scheduleSlots, windowBounds } from '@probe/core';
import { listSends, sentTodayCount } from '@probe/db';
import type { CampaignRow } from '@probe/db';
import type { GlobalConfig } from '@probe/config';
import { logger } from '@probe/config';

const log = logger('web:schedule');

export interface SlotPlan {
  scheduledFor: Date;
  /** The cap that applied on the chosen day: min(warmup tier, campaign cap). */
  cap: number;
  /** Sends already queued inside the chosen window. */
  queuedInWindow: number;
  /** Sends already dispatched today, only relevant when the day is today. */
  sentToday: number;
  /** True when no day inside the search horizon had capacity left. */
  overCapacity: boolean;
}

const DAY_MS = 86_400_000;
const HORIZON_DAYS = 21;

/**
 * Pick scheduled_for for a newly approved send (§8.5, §5.4).
 *
 * Walks forward day by day from now, skipping days that are not send days,
 * until it finds a window whose warmup cap still has room, then asks
 * scheduleSlots for an even spread across that window and takes the next
 * free slot. Pacing at dispatch time is the daemon's job; this only has to
 * put the row on the right day at a plausible minute.
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

  let firstOpenWindow: { start: Date; end: Date; cap: number; queuedInWindow: number } | null = null;
  let seenWindowStart = -1;

  for (let d = 0; d < HORIZON_DAYS; d += 1) {
    const probeAt = new Date(now.getTime() + d * DAY_MS);
    const bounds = windowBounds({ now: probeAt, timezone, window: global.send_window });
    if (bounds.start.getTime() === seenWindowStart) continue;
    seenWindowStart = bounds.start.getTime();

    // inSendWindow answers both questions at once: configured weekday, and
    // inside the hours. Probe one minute in so an inclusive bound is not lost.
    const insideDay = inSendWindow({
      now: new Date(bounds.start.getTime() + 60_000),
      timezone,
      sendDays: global.send_days,
      window: global.send_window,
    });
    if (!insideDay) continue;

    const from = new Date(Math.max(now.getTime(), bounds.start.getTime()));
    if (from.getTime() >= bounds.end.getTime()) continue;

    const cap = dailyCap({
      warmupStart: campaign.warmup_start,
      campaignDailyCap: campaign.daily_cap,
      now: bounds.start,
      timezone,
    });

    const queuedInWindow = queuedAt.filter(
      (t) => t >= bounds.start.getTime() && t < bounds.end.getTime(),
    ).length;

    if (!firstOpenWindow) {
      firstOpenWindow = { start: from, end: bounds.end, cap, queuedInWindow };
    }

    const used = queuedInWindow + (d === 0 ? sentToday : 0);
    if (used < cap) {
      const slots = scheduleSlots({
        from,
        end: bounds.end,
        count: used + 1,
        gapFloorMinutes: global.gap_floor_minutes,
        jitter: global.gap_jitter,
      });
      const chosen = slots[slots.length - 1] ?? from;
      return { scheduledFor: chosen, cap, queuedInWindow, sentToday, overCapacity: false };
    }
  }

  // Nothing had room inside the horizon. That happens when warmup has not
  // started (cap 0 on every day). Queue it at the next window start anyway:
  // the send daemon re-checks the cap and the kill switch before every single
  // send, so a row parked here can never turn into an unpaced dispatch.
  const fallback = firstOpenWindow;
  log.warn('no capacity inside the scheduling horizon', {
    campaign: campaign.slug,
    warmup_start: campaign.warmup_start ? String(campaign.warmup_start) : null,
    daily_cap: campaign.daily_cap,
  });
  return {
    scheduledFor: fallback ? fallback.start : new Date(now.getTime() + DAY_MS),
    cap: fallback ? fallback.cap : 0,
    queuedInWindow: fallback ? fallback.queuedInWindow : 0,
    sentToday,
    overCapacity: true,
  };
}
