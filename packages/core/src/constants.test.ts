import { describe, expect, it } from 'vitest';
import { DROP_REASONS, DROP_REASON_LABELS, SEVERITY_MAILABLE } from './constants';
import type { DropReason } from './constants';

describe('constants', () => {
  it('mails severity 1 only', () => {
    expect(SEVERITY_MAILABLE).toBe(1);
  });

  it('covers every drop reason in the 8.2 table exactly once', () => {
    expect(new Set(DROP_REASONS).size).toBe(DROP_REASONS.length);
    expect(DROP_REASONS).toEqual([
      'jurisdiction_blocked',
      'no_match',
      'suppressed',
      'contacted_other_campaign',
      'no_contact',
      'no_proof',
      'generator_failed',
    ]);
  });

  it('has a non-empty label for every reason and no label for anything else', () => {
    for (const reason of DROP_REASONS) {
      expect(DROP_REASON_LABELS[reason].length).toBeGreaterThan(0);
    }
    expect(Object.keys(DROP_REASON_LABELS).sort()).toEqual([...DROP_REASONS].sort());
  });

  it('keeps contacted_other_campaign distinct from suppressed', () => {
    // 8.2 depends on being able to tell a policy drop apart from an opt-out.
    const a: DropReason = 'contacted_other_campaign';
    const b: DropReason = 'suppressed';
    expect(DROP_REASON_LABELS[a]).not.toBe(DROP_REASON_LABELS[b]);
  });
});
