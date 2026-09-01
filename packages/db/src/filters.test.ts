import { describe, expect, it } from 'vitest';
import {
  buildLeadWhere,
  buildSendWhere,
  clampLimit,
  clampOffset,
  likePattern,
  MATCHED_OR_BEYOND_DROP_REASONS,
  statusForDropReason,
} from './filters';

describe('buildLeadWhere', () => {
  it('returns an empty clause for an empty filter', () => {
    expect(buildLeadWhere({})).toEqual({ text: '', params: [] });
  });

  it('numbers placeholders in order', () => {
    const chunk = buildLeadWhere({ status: 'matched', sourceId: 'show_hn' });
    expect(chunk.text).toBe('where l.status = $1 and l.source_id = $2');
    expect(chunk.params).toEqual(['matched', 'show_hn']);
  });

  it('casts campaign_id so a text parameter compares against a uuid column', () => {
    const chunk = buildLeadWhere({ campaignId: 'c0ffee' });
    expect(chunk.text).toBe('where l.campaign_id = $1::uuid');
  });

  it('honours a custom alias and start index', () => {
    const chunk = buildLeadWhere({ jurisdiction: 'US' }, 'x', 4);
    expect(chunk.text).toBe('where x.jurisdiction = $4');
    expect(chunk.params).toEqual(['US']);
  });

  it('reuses one placeholder across every searchable column', () => {
    const chunk = buildLeadWhere({ q: 'meter' });
    expect(chunk.params).toEqual(['%meter%']);
    expect(chunk.text.match(/\$1/g)).toHaveLength(4);
  });

  it('places the search placeholder after the earlier filters', () => {
    const chunk = buildLeadWhere({ status: 'sent', q: 'meter' });
    expect(chunk.text).toContain('$1');
    expect(chunk.text).toContain('$2');
    expect(chunk.params).toEqual(['sent', '%meter%']);
    expect(chunk.text).not.toContain('$3');
  });

  it('ignores a blank search string', () => {
    expect(buildLeadWhere({ q: '   ' }).params).toEqual([]);
  });

  it('never interpolates a value into the text', () => {
    const chunk = buildLeadWhere({ dropReason: "no_match'; drop table leads;--" });
    expect(chunk.text).toBe('where l.drop_reason = $1');
    expect(chunk.params[0]).toBe("no_match'; drop table leads;--");
  });
});

describe('buildSendWhere', () => {
  it('builds nothing for an empty filter', () => {
    expect(buildSendWhere({})).toEqual({ text: '', params: [] });
  });

  it('combines campaign and status', () => {
    const chunk = buildSendWhere({ campaignId: 'abc', status: 'queued' });
    expect(chunk.text).toBe('where s.campaign_id = $1::uuid and s.status = $2');
    expect(chunk.params).toEqual(['abc', 'queued']);
  });

  it('starts at the given index', () => {
    expect(buildSendWhere({ status: 'sent' }, 's', 3).text).toBe('where s.status = $3');
  });
});

describe('likePattern', () => {
  it('wraps in wildcards', () => {
    expect(likePattern('meter')).toBe('%meter%');
  });

  it('escapes LIKE metacharacters so they match literally', () => {
    expect(likePattern('100%')).toBe('%100\\%%');
    expect(likePattern('a_b')).toBe('%a\\_b%');
    expect(likePattern('c\\d')).toBe('%c\\\\d%');
  });

  it('trims the query', () => {
    expect(likePattern('  meter  ')).toBe('%meter%');
  });
});

describe('clampLimit and clampOffset', () => {
  it('falls back when absent or not a number', () => {
    expect(clampLimit(undefined, 100, 1000)).toBe(100);
    expect(clampLimit(Number.NaN, 100, 1000)).toBe(100);
  });

  it('clamps to the range and truncates', () => {
    expect(clampLimit(0, 100, 1000)).toBe(1);
    expect(clampLimit(-5, 100, 1000)).toBe(1);
    expect(clampLimit(99999, 100, 1000)).toBe(1000);
    expect(clampLimit(12.7, 100, 1000)).toBe(12);
  });

  it('floors the offset at zero', () => {
    expect(clampOffset(undefined)).toBe(0);
    expect(clampOffset(-3)).toBe(0);
    expect(clampOffset(20.9)).toBe(20);
  });
});

describe('statusForDropReason (§8.2)', () => {
  it('maps the three reasons that have their own terminal status', () => {
    expect(statusForDropReason('no_match')).toBe('no_match');
    expect(statusForDropReason('no_contact')).toBe('no_contact');
    expect(statusForDropReason('no_proof')).toBe('no_proof');
  });

  it('maps everything else to dropped', () => {
    expect(statusForDropReason('jurisdiction_blocked')).toBe('dropped');
    expect(statusForDropReason('suppressed')).toBe('dropped');
    expect(statusForDropReason('contacted_other_campaign')).toBe('dropped');
    expect(statusForDropReason('generator_failed')).toBe('dropped');
    expect(statusForDropReason('something_added_later')).toBe('dropped');
  });
});

describe('MATCHED_OR_BEYOND_DROP_REASONS', () => {
  it('holds exactly the reasons that can only happen after matching', () => {
    expect([...MATCHED_OR_BEYOND_DROP_REASONS]).toEqual([
      'contacted_other_campaign',
      'no_contact',
      'no_proof',
      'generator_failed',
    ]);
  });

  it('excludes the pre-match drops, which would deflate share_of_matched', () => {
    const list: readonly string[] = MATCHED_OR_BEYOND_DROP_REASONS;
    expect(list).not.toContain('jurisdiction_blocked');
    expect(list).not.toContain('no_match');
    expect(list).not.toContain('suppressed');
  });
});
