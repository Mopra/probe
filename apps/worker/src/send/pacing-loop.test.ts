import { describe, expect, it, vi } from 'vitest';
import { IDLE_BEAT_MS, MAX_SLEEP_MS, beatFor, sleepUntil } from './pacing-loop';

describe('sleepUntil', () => {
  it('sleeps the whole duration, not one chunk of it', async () => {
    // The regression this guards: an out-of-window wait used to return after
    // MAX_SLEEP_MS, so the caller ran a full iteration -- and a database query
    // -- every five minutes all night, which is what kept Neon's compute awake.
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      let done = false;
      const wait = sleepUntil(9 * 60 * 60_000, controller.signal).then(() => {
        done = true;
      });

      await vi.advanceTimersByTimeAsync(MAX_SLEEP_MS * 3);
      expect(done).toBe(false);

      await vi.advanceTimersByTimeAsync(9 * 60 * 60_000);
      await wait;
      expect(done).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('still wakes within one chunk of an abort', async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      let done = false;
      const wait = sleepUntil(9 * 60 * 60_000, controller.signal).then(() => {
        done = true;
      });

      await vi.advanceTimersByTimeAsync(1_000);
      controller.abort();
      await wait;
      expect(done).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns immediately for a signal that is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(sleepUntil(60_000, controller.signal)).resolves.toBeUndefined();
  });
});

describe('beatFor', () => {
  it('waits out the closed window rather than beating through it', () => {
    const nextStart = new Date(Date.now() + 9 * 60 * 60_000);
    const ms = beatFor({ kind: 'out_of_window', nextStart });
    expect(ms).toBeGreaterThan(8 * 60 * 60_000);
  });

  it('polls an empty queue no faster than the send gap floor', () => {
    // gap_floor_minutes is 4, so anything under that is a query with no
    // possible answer.
    expect(beatFor({ kind: 'idle' })).toBe(IDLE_BEAT_MS);
    expect(IDLE_BEAT_MS).toBeGreaterThanOrEqual(60_000);
  });
});
