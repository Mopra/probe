import { describe, expect, it } from 'vitest';
import { autoPauseDecision, MIN_VOLUME_FOR_RATE, type RollingRates } from './autopause';

// probe.toml, half of AWS's thresholds so we find out before they do (§5.5).
const COMPLAINT = 0.0005;
const BOUNCE = 0.03;

function rates(over: Partial<RollingRates> = {}): RollingRates {
  return { sent: 100, bounces: 0, complaints: 0, bounce_rate: 0, complaint_rate: 0, ...over };
}

function decide(r: RollingRates, over: { complaintThreshold?: number; bounceThreshold?: number } = {}) {
  return autoPauseDecision({
    rates: r,
    complaintThreshold: over.complaintThreshold ?? COMPLAINT,
    bounceThreshold: over.bounceThreshold ?? BOUNCE,
  });
}

describe('the minimum volume rule', () => {
  it('does not act on one bounce out of two sends', () => {
    // A 50% bounce rate on two sends is one bad address, not a signal. Pausing
    // on it would stop every campaign on its first warmup morning and would
    // teach the operator to ignore the pause.
    const decision = decide(rates({ sent: 2, bounces: 1, bounce_rate: 0.5 }));
    expect(decision.action).toBe('low_volume');
  });

  it('pauses on a complaint even below the minimum volume', () => {
    // The volume floor exists so one bad address on a campaign's first morning
    // does not read as a 50% bounce rate. A complaint is different in kind: at
    // these volumes one person calling a probe email spam is a signal about the
    // premise, so PAUSE_ON_ANY_COMPLAINT is checked before the floor.
    const decision = decide(
      rates({ sent: MIN_VOLUME_FOR_RATE - 1, complaints: 1, complaint_rate: 1 / 19 }),
    );
    expect(decision.action).toBe('pause');
    if (decision.action === 'pause') {
      expect(decision.breaches.join(' ')).toContain('1 complaint in the window');
    }
  });

  it('still applies the volume floor to bounces', () => {
    const decision = decide(rates({ sent: MIN_VOLUME_FOR_RATE - 1, bounces: 5, bounce_rate: 0.26 }));
    expect(decision.action).toBe('low_volume');
  });

  it('acts as soon as the window has enough sends behind it', () => {
    const decision = decide(
      rates({ sent: MIN_VOLUME_FOR_RATE, bounces: 1, bounce_rate: 1 / MIN_VOLUME_FOR_RATE }),
    );
    expect(decision.action).toBe('pause');
  });
});

describe('the thresholds', () => {
  it('leaves a clean campaign alone', () => {
    expect(decide(rates({ sent: 500 })).action).toBe('ok');
  });

  it('does not pause exactly at the threshold, only above it', () => {
    expect(decide(rates({ sent: 500, complaint_rate: COMPLAINT })).action).toBe('ok');
    expect(decide(rates({ sent: 500, bounce_rate: BOUNCE })).action).toBe('ok');
  });

  it('pauses on any complaint, and says so rather than quoting a rate', () => {
    const decision = decide(rates({ sent: 500, complaints: 1, complaint_rate: 0.002 }));
    expect(decision.action).toBe('pause');
    if (decision.action === 'pause') {
      // The reason the operator reads has to match the rule that fired. Quoting
      // a rate here would be technically true and misleading: the rate is not
      // what triggered it and would not have at a higher volume.
      expect(decision.breaches.join(' ')).toContain('1 complaint in the window');
    }
  });

  it('falls back to the complaint RATE when the window has no complaints of its own', () => {
    // Belt and braces: if PAUSE_ON_ANY_COMPLAINT is ever turned off, the §5.5
    // rate threshold is still the guard, so it stays tested.
    const decision = decide(
      rates({ sent: 5000, complaints: 0, complaint_rate: 0.002 }),
      { complaintThreshold: 0.0005 },
    );
    expect(decision.action).toBe('pause');
    if (decision.action === 'pause') {
      expect(decision.breaches.join(' ')).toContain('complaint rate');
    }
  });

  it('pauses on the bounce rate', () => {
    const decision = decide(rates({ sent: 500, bounces: 20, bounce_rate: 0.04 }));
    expect(decision.action).toBe('pause');
    if (decision.action === 'pause') {
      expect(decision.breaches.join(' ')).toContain('hard bounce rate');
    }
  });

  it('reports both breaches when both are over', () => {
    const decision = decide(rates({ sent: 500, complaint_rate: 0.002, bounce_rate: 0.09 }));
    expect(decision.action).toBe('pause');
    if (decision.action === 'pause') expect(decision.breaches).toHaveLength(2);
  });
});
