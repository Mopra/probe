import { describe, expect, it } from 'vitest';

import {
  WARMUP_CURVE,
  computeGapMs,
  dailyCap,
  inSendWindow,
  scheduleSlots,
  warmupDay,
  windowBounds,
} from './pacing';

const TZ = 'Europe/Copenhagen';
const WINDOW: [string, string] = ['09:00', '16:00'];
const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri'];

const at = (iso: string): Date => new Date(iso);

/** Deterministic, so a jittered function can be asserted exactly. */
function seededRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

describe('WARMUP_CURVE', () => {
  it('is the §5.4 table', () => {
    expect(WARMUP_CURVE).toEqual([
      { minDay: 1, maxDay: 3, cap: 5 },
      { minDay: 4, maxDay: 7, cap: 10 },
      { minDay: 8, maxDay: 14, cap: 20 },
      { minDay: 15, maxDay: 21, cap: 35 },
      { minDay: 22, maxDay: null, cap: 50 },
    ]);
  });

  it('holds at every tier boundary', () => {
    // 08:00Z is 10:00 Europe/Copenhagen in September.
    const expected: Array<[string, number, number]> = [
      ['2026-09-01T08:00:00Z', 1, 5],
      ['2026-09-03T08:00:00Z', 3, 5],
      ['2026-09-04T08:00:00Z', 4, 10],
      ['2026-09-07T08:00:00Z', 7, 10],
      ['2026-09-08T08:00:00Z', 8, 20],
      ['2026-09-14T08:00:00Z', 14, 20],
      ['2026-09-15T08:00:00Z', 15, 35],
      ['2026-09-21T08:00:00Z', 21, 35],
      ['2026-09-22T08:00:00Z', 22, 50],
      ['2026-12-01T08:00:00Z', 92, 50],
    ];
    for (const [iso, day, cap] of expected) {
      expect(warmupDay('2026-09-01', at(iso), TZ), iso).toBe(day);
      expect(dailyCap({ warmupStart: '2026-09-01', campaignDailyCap: 50, now: at(iso), timezone: TZ }), iso).toBe(cap);
    }
  });
});

describe('warmupDay', () => {
  it('is 0 when warmup has not started', () => {
    expect(warmupDay(null, at('2026-09-01T08:00:00Z'), TZ)).toBe(0);
    expect(warmupDay('2026-09-05', at('2026-09-01T08:00:00Z'), TZ)).toBe(0);
  });

  it('counts day 1 as warmupStart itself, in the campaign timezone', () => {
    // 22:30Z on 31 August is already 1 September in Copenhagen.
    expect(warmupDay('2026-09-01', at('2026-08-31T22:30:00Z'), TZ)).toBe(1);
    expect(warmupDay('2026-09-01', at('2026-08-31T20:30:00Z'), TZ)).toBe(0);
  });

  it('accepts a Date as well as a YYYY-MM-DD string', () => {
    expect(warmupDay(new Date('2026-09-01T00:00:00Z'), at('2026-09-03T08:00:00Z'), TZ)).toBe(3);
  });

  it('counts calendar days across a DST change, not 24 hour blocks', () => {
    // 25 March to 2 April spans the 29 March transition.
    expect(warmupDay('2026-03-25', at('2026-04-02T08:00:00Z'), TZ)).toBe(9);
  });
});

describe('dailyCap', () => {
  it('is 0 before warmup starts', () => {
    expect(dailyCap({ warmupStart: null, campaignDailyCap: 50, now: at('2026-09-01T08:00:00Z'), timezone: TZ })).toBe(0);
  });

  it('takes the lower of the curve and the campaign cap', () => {
    const now = at('2026-12-01T08:00:00Z');
    expect(dailyCap({ warmupStart: '2026-09-01', campaignDailyCap: 25, now, timezone: TZ })).toBe(25);
    expect(dailyCap({ warmupStart: '2026-09-01', campaignDailyCap: 500, now, timezone: TZ })).toBe(50);
    expect(
      dailyCap({ warmupStart: '2026-09-01', campaignDailyCap: 25, now: at('2026-09-01T08:00:00Z'), timezone: TZ }),
    ).toBe(5);
  });
});

describe('windowBounds', () => {
  it('resolves 09:00 to 16:00 local on a CET day', () => {
    const { start, end } = windowBounds({ now: at('2026-03-27T10:00:00Z'), timezone: TZ, window: WINDOW });
    expect(start.toISOString()).toBe('2026-03-27T08:00:00.000Z');
    expect(end.toISOString()).toBe('2026-03-27T15:00:00.000Z');
  });

  it('resolves 09:00 to 16:00 local on a CEST day, one hour earlier in UTC', () => {
    const { start, end } = windowBounds({ now: at('2026-03-30T10:00:00Z'), timezone: TZ, window: WINDOW });
    expect(start.toISOString()).toBe('2026-03-30T07:00:00.000Z');
    expect(end.toISOString()).toBe('2026-03-30T14:00:00.000Z');
  });

  it('is right on the DST transition day itself', () => {
    const { start } = windowBounds({ now: at('2026-03-29T10:00:00Z'), timezone: TZ, window: WINDOW });
    expect(start.toISOString()).toBe('2026-03-29T07:00:00.000Z');
    const back = windowBounds({ now: at('2026-10-26T10:00:00Z'), timezone: TZ, window: WINDOW });
    expect(back.start.toISOString()).toBe('2026-10-26T08:00:00.000Z');
  });
});

describe('inSendWindow', () => {
  const check = (iso: string): boolean =>
    inSendWindow({ now: at(iso), timezone: TZ, sendDays: WEEKDAYS, window: WINDOW });

  it('is open on a weekday inside the window and closed outside it', () => {
    expect(check('2026-09-01T07:00:00Z')).toBe(true); // 09:00 local, inclusive start
    expect(check('2026-09-01T11:59:00Z')).toBe(true); // 13:59 local
    expect(check('2026-09-01T13:59:00Z')).toBe(true); // 15:59 local
    expect(check('2026-09-01T14:00:00Z')).toBe(false); // 16:00 local, exclusive end
    expect(check('2026-09-01T06:59:00Z')).toBe(false); // 08:59 local
  });

  it('is closed all weekend and open again on Monday', () => {
    expect(check('2026-03-27T10:00:00Z')).toBe(true); // Friday 11:00
    expect(check('2026-03-28T10:00:00Z')).toBe(false); // Saturday 11:00
    expect(check('2026-03-29T10:00:00Z')).toBe(false); // Sunday 12:00, DST day
    expect(check('2026-03-30T10:00:00Z')).toBe(true); // Monday 12:00
  });

  it('follows the wall clock across the spring DST change', () => {
    // 07:30Z is 08:30 on the Friday before the change, and 09:30 on the Monday
    // after it. Same instant of day, different side of the window edge.
    expect(check('2026-03-27T07:30:00Z')).toBe(false);
    expect(check('2026-03-30T07:30:00Z')).toBe(true);
    // 14:30Z is 15:30 local before the change and 16:30 local after it.
    expect(check('2026-03-27T14:30:00Z')).toBe(true);
    expect(check('2026-03-30T14:30:00Z')).toBe(false);
  });

  it('honours a different set of send days', () => {
    expect(
      inSendWindow({ now: at('2026-03-28T10:00:00Z'), timezone: TZ, sendDays: ['sat'], window: WINDOW }),
    ).toBe(true);
  });
});

describe('computeGapMs', () => {
  const floorMs = 4 * 60_000;

  it('derives the gap from the remaining window, not a fixed range', () => {
    // The §5.4 point: 7 hours across 50 sends is one every 8.4 minutes. A
    // fixed 4 to 22 minute range averages 13 and can never get there.
    const gap = computeGapMs({
      remainingWindowMs: 7 * 60 * 60_000,
      remainingQuota: 50,
      gapFloorMinutes: 4,
      jitter: 0.4,
      rng: () => 0.5,
    });
    expect(gap).toBe(504_000);
    expect(gap / 60_000).toBeCloseTo(8.4, 5);
  });

  it('jitters by the configured factor in both directions', () => {
    const base = { remainingWindowMs: 7 * 60 * 60_000, remainingQuota: 50, gapFloorMinutes: 4, jitter: 0.4 };
    expect(computeGapMs({ ...base, rng: () => 0 })).toBe(Math.round(504_000 * 0.6));
    expect(computeGapMs({ ...base, rng: () => 1 })).toBe(Math.round(504_000 * 1.4));
  });

  it('stays inside the jitter band without an rng', () => {
    for (let i = 0; i < 200; i += 1) {
      const gap = computeGapMs({
        remainingWindowMs: 7 * 60 * 60_000,
        remainingQuota: 50,
        gapFloorMinutes: 4,
        jitter: 0.4,
      });
      expect(gap).toBeGreaterThanOrEqual(Math.round(504_000 * 0.6));
      expect(gap).toBeLessThanOrEqual(Math.round(504_000 * 1.4));
    }
  });

  it('holds the floor when the arithmetic asks for less', () => {
    expect(
      computeGapMs({ remainingWindowMs: 10 * 60_000, remainingQuota: 50, gapFloorMinutes: 4, jitter: 0.4, rng: () => 0.5 }),
    ).toBe(floorMs);
  });

  it('returns the floor when the quota is spent or the window has run out', () => {
    expect(computeGapMs({ remainingWindowMs: 7 * 60 * 60_000, remainingQuota: 0, gapFloorMinutes: 4, jitter: 0.4 })).toBe(
      floorMs,
    );
    expect(computeGapMs({ remainingWindowMs: -1, remainingQuota: 10, gapFloorMinutes: 4, jitter: 0.4 })).toBe(floorMs);
  });

  it('early warmup days spread across the whole window instead of clustering', () => {
    const gap = computeGapMs({
      remainingWindowMs: 7 * 60 * 60_000,
      remainingQuota: 5,
      gapFloorMinutes: 4,
      jitter: 0.4,
      rng: () => 0.5,
    });
    expect(gap / 60_000).toBeCloseTo(84, 5);
  });
});

describe('scheduleSlots', () => {
  const from = at('2026-09-01T07:00:00Z'); // 09:00 Copenhagen
  const end = at('2026-09-01T14:00:00Z'); // 16:00 Copenhagen

  it('spreads a full day across the window, strictly increasing and inside the bounds', () => {
    const slots = scheduleSlots({ from, end, count: 50, gapFloorMinutes: 4, jitter: 0.4, rng: seededRng(7) });
    expect(slots).toHaveLength(50);
    expect(slots[0].getTime()).toBeGreaterThanOrEqual(from.getTime());
    for (let i = 1; i < slots.length; i += 1) {
      expect(slots[i].getTime()).toBeGreaterThan(slots[i - 1].getTime());
      expect(slots[i].getTime() - slots[i - 1].getTime()).toBeGreaterThanOrEqual(4 * 60_000);
    }
    expect(slots[slots.length - 1].getTime()).toBeLessThan(end.getTime());
  });

  it('is deterministic for a given rng', () => {
    const a = scheduleSlots({ from, end, count: 12, gapFloorMinutes: 4, jitter: 0.4, rng: seededRng(3) });
    const b = scheduleSlots({ from, end, count: 12, gapFloorMinutes: 4, jitter: 0.4, rng: seededRng(3) });
    expect(a.map((d) => d.toISOString())).toEqual(b.map((d) => d.toISOString()));
  });

  it('returns only what fits at the floor spacing, leaving the rest for the next day', () => {
    const shortEnd = at('2026-09-01T07:30:00Z'); // half an hour of window left
    const slots = scheduleSlots({ from, end: shortEnd, count: 20, gapFloorMinutes: 4, jitter: 0.4, rng: () => 0.5 });
    expect(slots).toHaveLength(8);
    expect(slots[slots.length - 1].getTime()).toBeLessThan(shortEnd.getTime());
  });

  it('never schedules before `from` and returns nothing for a closed window', () => {
    const slots = scheduleSlots({ from, end: from, count: 5, gapFloorMinutes: 4, jitter: 0.4, rng: () => 0.5 });
    expect(slots).toEqual([]);
    expect(scheduleSlots({ from, end, count: 0, gapFloorMinutes: 4, jitter: 0.4 })).toEqual([]);
  });
});
