import { describe, expect, it } from 'vitest';
import { looksProbeable, matchLead } from './match';
import type { MatchCandidate, MatchInput } from './match';

const EXIT1: MatchCandidate = {
  slug: 'exit1',
  excludeTags: ['monitoring', 'observability', 'uptime', 'status-page', 'apm'],
  excludeKeywords: [
    'uptime monitor',
    'status page',
    'observability',
    'monitoring platform',
    'apm',
    'incident management',
  ],
};

const DAY3: MatchCandidate = { slug: 'day3', excludeTags: [], excludeKeywords: [] };

function lead(overrides: Partial<MatchInput> = {}): MatchInput {
  return {
    name: 'Meterbase',
    url: 'https://meterbase.dev',
    description: 'Usage-based billing for API companies',
    tags: ['api', 'billing', 'developer-tools'],
    ...overrides,
  };
}

describe('looksProbeable', () => {
  it('is true when the tags carry an API or docs signal', () => {
    expect(looksProbeable(lead({ tags: ['api'], description: null }))).toBe(true);
    expect(looksProbeable(lead({ tags: ['developer-tools'], description: null }))).toBe(true);
    expect(looksProbeable(lead({ tags: ['SaaS'], description: null }))).toBe(true);
  });

  it('is true when the description carries the signal', () => {
    expect(
      looksProbeable(lead({ tags: [], description: 'A REST endpoint for invoice PDFs' })),
    ).toBe(true);
    expect(looksProbeable(lead({ tags: [], description: 'GraphQL webhooks for Shopify' }))).toBe(
      true,
    );
  });

  it('is false for a product with no reachable surface described', () => {
    expect(
      looksProbeable(lead({ tags: ['design', 'fonts'], description: 'A typeface for receipts' })),
    ).toBe(false);
    expect(looksProbeable(lead({ tags: [], description: null }))).toBe(false);
  });

  it('does not fire on a substring', () => {
    expect(looksProbeable(lead({ tags: [], description: 'Rapid apis? no, rapidly grown' }))).toBe(
      true,
    );
    expect(looksProbeable(lead({ tags: [], description: 'Rapidly grown therapy notes' }))).toBe(
      false,
    );
  });
});

describe('matchLead', () => {
  it('requires https', () => {
    expect(matchLead({ lead: lead({ url: 'http://meterbase.dev' }), candidates: [EXIT1], rrCounter: 0 })).toEqual(
      { slug: null, reason: 'not_https', detail: 'http://meterbase.dev' },
    );
    expect(matchLead({ lead: lead({ url: 'meterbase.dev' }), candidates: [EXIT1], rrCounter: 0 }).reason).toBe(
      'not_https',
    );
  });

  it('returns no_campaign when there are no candidates', () => {
    expect(matchLead({ lead: lead(), candidates: [], rrCounter: 0 })).toEqual({
      slug: null,
      reason: 'no_campaign',
    });
  });

  it('excludes on a tag and names the tag', () => {
    const result = matchLead({
      lead: lead({ tags: ['api', 'Monitoring'] }),
      candidates: [EXIT1],
      rrCounter: 0,
    });
    expect(result).toEqual({ slug: null, reason: 'excluded_tag', detail: 'monitoring' });
  });

  it('normalizes tag separators before comparing', () => {
    const result = matchLead({
      lead: lead({ tags: ['Status Page'] }),
      candidates: [EXIT1],
      rrCounter: 0,
    });
    expect(result).toEqual({ slug: null, reason: 'excluded_tag', detail: 'status-page' });
  });

  it('excludes on a description keyword and names the keyword', () => {
    const result = matchLead({
      lead: lead({ tags: ['api'], description: 'The uptime monitor built for teams' }),
      candidates: [EXIT1],
      rrCounter: 0,
    });
    expect(result).toEqual({ slug: null, reason: 'excluded_keyword', detail: 'uptime monitor' });
  });

  it('checks tags before keywords', () => {
    const result = matchLead({
      lead: lead({ tags: ['apm'], description: 'An uptime monitor' }),
      candidates: [EXIT1],
      rrCounter: 0,
    });
    expect(result.reason).toBe('excluded_tag');
  });

  it('does not fire a keyword on a substring', () => {
    const result = matchLead({
      lead: lead({ tags: ['api'], description: 'APMEX bullion price feeds' }),
      candidates: [EXIT1],
      rrCounter: 0,
    });
    expect(result.reason).toBe('matched');
  });

  it('routes to the surviving campaign when the other is excluded', () => {
    const result = matchLead({
      lead: lead({ tags: ['monitoring'] }),
      candidates: [EXIT1, DAY3],
      rrCounter: 0,
    });
    expect(result).toEqual({ slug: 'day3', reason: 'matched' });
  });

  it('prefers exit1 when the product looks probeable', () => {
    const result = matchLead({
      lead: lead({ tags: ['api', 'docs'] }),
      candidates: [EXIT1, DAY3],
      rrCounter: 1,
    });
    expect(result.slug).toBe('exit1');
    expect(result.reason).toBe('matched');
  });

  it('round robins when no generator is favoured, so neither campaign starves', () => {
    const plain = lead({ tags: ['design'], description: 'A typeface for receipts' });
    const slugs = [0, 1, 2, 3].map(
      (rrCounter) => matchLead({ lead: plain, candidates: [EXIT1, DAY3], rrCounter }).slug,
    );
    expect(slugs).toEqual(['exit1', 'day3', 'exit1', 'day3']);
  });

  it('round robins safely for a negative or non-integer counter', () => {
    const plain = lead({ tags: ['design'], description: 'A typeface for receipts' });
    expect(matchLead({ lead: plain, candidates: [EXIT1, DAY3], rrCounter: -1 }).slug).toBe('day3');
    expect(matchLead({ lead: plain, candidates: [EXIT1, DAY3], rrCounter: 2.7 }).slug).toBe('exit1');
  });

  it('assigns exactly one campaign, never two', () => {
    const result = matchLead({ lead: lead(), candidates: [EXIT1, DAY3], rrCounter: 0 });
    expect(typeof result.slug).toBe('string');
    expect(['exit1', 'day3']).toContain(result.slug);
  });

  it('reports the first campaign exclusion when every candidate is excluded', () => {
    const strictDay3: MatchCandidate = {
      slug: 'day3',
      excludeTags: ['api'],
      excludeKeywords: [],
    };
    const result = matchLead({
      lead: lead({ tags: ['api', 'uptime'] }),
      candidates: [EXIT1, strictDay3],
      rrCounter: 0,
    });
    expect(result.slug).toBeNull();
    expect(result.reason).toBe('excluded_tag');
    expect(result.detail).toBe('uptime');
  });
});
