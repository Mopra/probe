/**
 * Warmup and pacing (§5.4).
 *
 * Two ideas carry this module.
 *
 * First, the warmup curve is fixed per sending subdomain and has no manual
 * override. Second, gaps are computed rather than picked from a fixed range: a
 * 4 to 22 minute range averages 13 minutes, fits about 32 sends in a seven
 * hour window, and can therefore never reach a 35 or 50 per day cap. Each gap
 * is the remaining window divided by the remaining quota, jittered, and
 * floored, which also makes early warmup days spread 5 sends across the whole
 * window instead of clustering them at 09:00.
 *
 * Timezone handling is Intl only, no dependency.
 */

export interface WarmupTier {
  minDay: number;
  maxDay: number | null;
  cap: number;
}

/** §5.4. Days are inclusive; the last tier is open ended. */
export const WARMUP_CURVE: WarmupTier[] = [
  { minDay: 1, maxDay: 3, cap: 5 },
  { minDay: 4, maxDay: 7, cap: 10 },
  { minDay: 8, maxDay: 14, cap: 20 },
  { minDay: 15, maxDay: 21, cap: 35 },
  { minDay: 22, maxDay: null, cap: 50 },
];

const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 86_400_000;

const WEEKDAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

interface WallClock {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: string; // 'mon' ... 'sun'
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timezone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timezone);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'short',
  });
  formatterCache.set(timezone, formatter);
  return formatter;
}

/** Wall clock parts of an instant in an IANA timezone. */
function partsIn(instant: Date, timezone: string): WallClock {
  const parts = formatterFor(timezone).formatToParts(instant);
  const lookup: Record<string, string> = {};
  for (const part of parts) if (part.type !== 'literal') lookup[part.type] = part.value;
  const hour = Number(lookup.hour);
  return {
    year: Number(lookup.year),
    month: Number(lookup.month),
    day: Number(lookup.day),
    // Some ICU versions render midnight as 24 under h23 formatToParts.
    hour: hour === 24 ? 0 : hour,
    minute: Number(lookup.minute),
    second: Number(lookup.second),
    weekday: (lookup.weekday ?? '').slice(0, 3).toLowerCase(),
  };
}

/** Offset of the timezone at that instant, in ms (zone time minus UTC). */
function offsetAt(instant: Date, timezone: string): number {
  const p = partsIn(instant, timezone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second, instant.getUTCMilliseconds());
  return asUtc - instant.getTime();
}

/**
 * Converts a wall clock date and time in a timezone back to an instant. The
 * offset is applied twice because the first guess uses the offset in force at
 * the naive UTC instant, which is the wrong side of a DST transition for
 * roughly one hour twice a year.
 */
function instantFrom(
  timezone: string,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second = 0,
): Date {
  const naive = Date.UTC(year, month - 1, day, hour, minute, second);
  const firstGuess = naive - offsetAt(new Date(naive), timezone);
  const secondGuess = naive - offsetAt(new Date(firstGuess), timezone);
  return new Date(secondGuess);
}

/** Calendar day number of a wall clock date, for day arithmetic that DST
 *  cannot perturb. */
function epochDay(year: number, month: number, day: number): number {
  return Date.UTC(year, month - 1, day) / MS_PER_DAY;
}

function calendarDateIn(value: Date | string, timezone: string): { year: number; month: number; day: number } {
  if (typeof value === 'string') {
    const plain = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
    if (plain) {
      return { year: Number(plain[1]), month: Number(plain[2]), day: Number(plain[3]) };
    }
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return { year: NaN, month: NaN, day: NaN };
    const p = partsIn(parsed, timezone);
    return { year: p.year, month: p.month, day: p.day };
  }
  const p = partsIn(value, timezone);
  return { year: p.year, month: p.month, day: p.day };
}

function parseHhMm(value: string): { hour: number; minute: number } {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) return { hour: NaN, minute: NaN };
  return { hour: Number(m[1]), minute: Number(m[2]) };
}

// ---------------------------------------------------------------------------
// warmup
// ---------------------------------------------------------------------------

/** Day 1 is warmupStart itself, counted in calendar days in the campaign
 *  timezone. Returns 0 when warmupStart is null or still in the future. */
export function warmupDay(warmupStart: Date | string | null, now: Date, timezone: string): number {
  if (warmupStart === null || warmupStart === undefined) return 0;
  const start = calendarDateIn(warmupStart, timezone);
  if (Number.isNaN(start.year)) return 0;
  const today = partsIn(now, timezone);
  const day = epochDay(today.year, today.month, today.day) - epochDay(start.year, start.month, start.day) + 1;
  return day < 1 ? 0 : day;
}

/**
 * The warmup cap for a given day number, ignoring the campaign's own daily_cap.
 * 0 for day 0, which is what warmupDay() returns before warmup has started.
 *
 * Exported because the dashboard needs it: it holds warmup_day (from a SQL
 * expression) and daily_cap, and showing `daily_cap - sent_today` as "remaining"
 * overstates the real ceiling tenfold on day one. The operator watches that
 * number on the first sending morning, so it has to be the true one.
 */
export function curveCap(day: number): number {
  for (const tier of WARMUP_CURVE) {
    if (day >= tier.minDay && (tier.maxDay === null || day <= tier.maxDay)) return tier.cap;
  }
  return 0;
}

/** min(warmup cap for a day number, campaign daily_cap). The effective cap. */
export function capForWarmupDay(warmupDayNumber: number, campaignDailyCap: number): number {
  if (warmupDayNumber <= 0) return 0;
  return Math.min(curveCap(warmupDayNumber), Math.max(0, campaignDailyCap));
}

/** min(warmup cap for today, campaign daily_cap). 0 before warmup starts. */
export function dailyCap(args: {
  warmupStart: Date | string | null;
  campaignDailyCap: number;
  now: Date;
  timezone: string;
}): number {
  const day = warmupDay(args.warmupStart, args.now, args.timezone);
  if (day === 0) return 0;
  return Math.min(curveCap(day), Math.max(0, args.campaignDailyCap));
}

// ---------------------------------------------------------------------------
// send window
// ---------------------------------------------------------------------------

/** Start and end of the window on `now`'s calendar day, as absolute instants. */
export function windowBounds(args: {
  now: Date;
  timezone: string;
  window: [string, string];
}): { start: Date; end: Date } {
  const today = partsIn(args.now, args.timezone);
  const from = parseHhMm(args.window[0]);
  const to = parseHhMm(args.window[1]);
  const start = instantFrom(args.timezone, today.year, today.month, today.day, from.hour, from.minute);
  const end = instantFrom(args.timezone, today.year, today.month, today.day, to.hour, to.minute);
  return { start, end };
}

/** True when `now` falls on a configured send day and inside [start, end) in
 *  the campaign timezone. */
export function inSendWindow(args: {
  now: Date;
  timezone: string;
  sendDays: string[];
  window: [string, string];
}): boolean {
  const today = partsIn(args.now, args.timezone);
  const allowed = new Set(args.sendDays.map((d) => d.trim().slice(0, 3).toLowerCase()));
  if (!WEEKDAY_KEYS.includes(today.weekday as (typeof WEEKDAY_KEYS)[number])) return false;
  if (!allowed.has(today.weekday)) return false;
  const { start, end } = windowBounds({ now: args.now, timezone: args.timezone, window: args.window });
  const at = args.now.getTime();
  return at >= start.getTime() && at < end.getTime();
}

// ---------------------------------------------------------------------------
// gaps
// ---------------------------------------------------------------------------

function jitterFactor(jitter: number, rng?: () => number): number {
  const bounded = Math.max(0, Math.min(1, jitter));
  const roll = rng ? rng() : Math.random();
  return 1 - bounded + 2 * bounded * roll;
}

/**
 * remaining window / remaining quota, jittered by a uniform factor in
 * [1 - jitter, 1 + jitter], then floored at gapFloorMinutes. Returns the floor
 * when the quota is spent or the window has run out. Deterministic when `rng`
 * is supplied.
 */
export function computeGapMs(args: {
  remainingWindowMs: number;
  remainingQuota: number;
  gapFloorMinutes: number;
  jitter: number;
  rng?: () => number;
}): number {
  const floor = Math.max(0, args.gapFloorMinutes) * MS_PER_MINUTE;
  if (args.remainingQuota <= 0 || args.remainingWindowMs <= 0) return floor;
  const base = args.remainingWindowMs / args.remainingQuota;
  const jittered = base * jitterFactor(args.jitter, args.rng);
  return Math.max(floor, Math.round(jittered));
}

/**
 * `count` instants spread across [from, end) using the same computed gap rule,
 * each jittered, never before `from`, strictly increasing, never at or past
 * `end`.
 *
 * When `count` slots cannot fit at the floor spacing, only the ones that fit
 * are returned. The caller is expected to schedule the remainder on the next
 * send day: this function never compresses below the floor and never runs past
 * the end of the window.
 */
export function scheduleSlots(args: {
  from: Date;
  end: Date;
  count: number;
  gapFloorMinutes: number;
  jitter: number;
  rng?: () => number;
}): Date[] {
  const slots: Date[] = [];
  if (args.count <= 0) return slots;

  const endMs = args.end.getTime();
  let cursor = args.from.getTime();

  for (let i = 0; i < args.count; i += 1) {
    if (cursor >= endMs) break;
    slots.push(new Date(cursor));
    const gap = computeGapMs({
      remainingWindowMs: endMs - cursor,
      remainingQuota: args.count - i,
      gapFloorMinutes: args.gapFloorMinutes,
      jitter: args.jitter,
      rng: args.rng,
    });
    cursor += Math.max(1, gap);
  }

  return slots;
}

// ---------------------------------------------------------------------------
// picking a slot for a newly approved send
// ---------------------------------------------------------------------------

export interface SlotPlan {
  scheduledFor: Date;
  /** The cap that applied on the chosen day: min(warmup tier, campaign cap). */
  cap: number;
  /** Sends already queued inside the chosen window. */
  queuedInWindow: number;
  /** Sends already dispatched today, only relevant when the day is today. */
  sentToday: number;
  /** True when no day inside the horizon had capacity left. */
  overCapacity: boolean;
}

const HORIZON_DAYS = 21;

/**
 * Pick scheduled_for for a newly approved send (§8.5, §5.4).
 *
 * Walks forward day by day from `now`, skipping days that are not send days,
 * until it finds a window whose warmup cap still has room, then asks
 * scheduleSlots for an even spread across that window and takes the next free
 * slot. Pacing at dispatch time is the daemon's job; this only has to put the
 * row on the right day at a plausible minute.
 *
 * Pure: the caller supplies the two numbers that come from the database, the
 * queued sends' scheduled_for and today's dispatched count. It lives here
 * rather than in either application because both the /queue approval and the
 * worker's auto-approval have to place a row the same way, and a second copy
 * of this walk is a second answer to "which day does this land on".
 *
 * `overCapacity` is a caller's decision, not a refusal. A human approving in
 * /queue is told and the row is still written at the fallback slot; the
 * auto-approver leaves the proof in the queue and tries again tomorrow.
 */
export function planSendSlot(args: {
  now: Date;
  timezone: string;
  sendDays: string[];
  window: [string, string];
  gapFloorMinutes: number;
  jitter: number;
  warmupStart: Date | string | null;
  campaignDailyCap: number;
  /** scheduled_for of every send already queued for this campaign, epoch ms. */
  queuedAt: number[];
  /** Sends already dispatched today for this campaign. */
  sentToday: number;
  horizonDays?: number;
  rng?: () => number;
}): SlotPlan {
  const { now, timezone, sentToday } = args;
  const horizon = args.horizonDays ?? HORIZON_DAYS;

  let firstOpenWindow: { start: Date; end: Date; cap: number; queuedInWindow: number } | null = null;
  let seenWindowStart = -1;

  for (let d = 0; d < horizon; d += 1) {
    const probeAt = new Date(now.getTime() + d * MS_PER_DAY);
    const bounds = windowBounds({ now: probeAt, timezone, window: args.window });
    if (bounds.start.getTime() === seenWindowStart) continue;
    seenWindowStart = bounds.start.getTime();

    // inSendWindow answers both questions at once: configured weekday, and
    // inside the hours. Probe one minute in so an inclusive bound is not lost.
    const insideDay = inSendWindow({
      now: new Date(bounds.start.getTime() + 60_000),
      timezone,
      sendDays: args.sendDays,
      window: args.window,
    });
    if (!insideDay) continue;

    const from = new Date(Math.max(now.getTime(), bounds.start.getTime()));
    if (from.getTime() >= bounds.end.getTime()) continue;

    const cap = dailyCap({
      warmupStart: args.warmupStart,
      campaignDailyCap: args.campaignDailyCap,
      now: bounds.start,
      timezone,
    });

    const queuedInWindow = args.queuedAt.filter(
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
        gapFloorMinutes: args.gapFloorMinutes,
        jitter: args.jitter,
        rng: args.rng,
      });
      const chosen = slots[slots.length - 1] ?? from;
      return { scheduledFor: chosen, cap, queuedInWindow, sentToday, overCapacity: false };
    }
  }

  // Nothing had room inside the horizon. The ordinary cause is that warmup has
  // not started, which makes the cap 0 on every day.
  const fallback = firstOpenWindow;
  return {
    scheduledFor: fallback ? fallback.start : new Date(now.getTime() + MS_PER_DAY),
    cap: fallback ? fallback.cap : 0,
    queuedInWindow: fallback ? fallback.queuedInWindow : 0,
    sentToday,
    overCapacity: true,
  };
}
