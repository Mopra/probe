import { describe, expect, it } from 'vitest';
import { deriveTags, hitToRawLead, parseShowHnTitle, plainText } from './show-hn';

describe('parseShowHnTitle', () => {
  it('strips the Show HN prefix', () => {
    expect(parseShowHnTitle('Show HN: Meterbase')).toEqual({ name: 'Meterbase', tagline: null });
  });

  it('splits a dash tagline off the product name', () => {
    expect(parseShowHnTitle('Show HN: Meterbase \u2013 Usage-based billing for API companies')).toEqual({
      name: 'Meterbase',
      tagline: 'Usage-based billing for API companies',
    });
  });

  it('handles an em dash and a plain hyphen the same way', () => {
    expect(parseShowHnTitle('Show HN: Foo \u2014 a bar').name).toBe('Foo');
    expect(parseShowHnTitle('Show HN: Foo - a bar').name).toBe('Foo');
  });

  it('keeps a hyphenated product name intact', () => {
    expect(parseShowHnTitle('Show HN: Type-safe DB')).toEqual({ name: 'Type-safe DB', tagline: null });
  });

  it('splits on a second colon', () => {
    expect(parseShowHnTitle('Show HN: Kettle: a tiny job runner')).toEqual({
      name: 'Kettle',
      tagline: 'a tiny job runner',
    });
  });

  it('tolerates a missing prefix and odd casing', () => {
    expect(parseShowHnTitle('show hn - Widget | does widgets')).toEqual({
      name: 'Widget',
      tagline: 'does widgets',
    });
  });

  it('never returns an empty name', () => {
    expect(parseShowHnTitle('Show HN:').name).toBe('Show HN:');
  });
});

describe('deriveTags', () => {
  it('derives from the title and the body together', () => {
    const tags = deriveTags('Show HN: Meterbase - usage-based billing for API companies', 'Our SDK is open source');
    expect(tags).toContain('api');
    expect(tags).toContain('billing');
    expect(tags).toContain('developer-tools');
    expect(tags).toContain('open-source');
  });

  it('tags the exclusion vocabulary that §8.2 gates on', () => {
    const tags = deriveTags('Show HN: Pulse, an uptime monitor with a status page');
    expect(tags).toEqual(expect.arrayContaining(['monitoring', 'uptime', 'status-page']));
  });

  it('returns nothing for text with no signal', () => {
    expect(deriveTags('Show HN: Quiet')).toEqual([]);
  });

  it('caps the number of tags', () => {
    const tags = deriveTags(
      'api sdk cli saas billing ai open source monitoring observability uptime status page apm analytics security postgres docs',
    );
    expect(tags.length).toBeLessThanOrEqual(6);
  });
});

describe('plainText', () => {
  it('decodes entities and flattens markup', () => {
    expect(plainText('<p>Hi &amp; welcome</p><p>to  probe</p>')).toBe('Hi & welcome to probe');
  });
});

describe('hitToRawLead', () => {
  const base = {
    objectID: '42',
    title: 'Show HN: Meterbase \u2013 Usage-based billing for API companies',
    url: 'https://meterbase.dev',
    author: 'priya',
    created_at: '2026-09-01T06:00:00Z',
    story_text: null,
  };

  it('maps a hit onto a RawLead', () => {
    const lead = hitToRawLead(base);
    expect(lead).not.toBeNull();
    expect(lead?.external_id).toBe('42');
    expect(lead?.name).toBe('Meterbase');
    expect(lead?.description).toBe('Usage-based billing for API companies');
    expect(lead?.launched_at?.toISOString()).toBe('2026-09-01T06:00:00.000Z');
  });

  it('populates the submitter, which is step 2 of the cascade', () => {
    expect(hitToRawLead(base)?.submitter).toEqual({
      handle: 'priya',
      profile_url: 'https://news.ycombinator.com/user?id=priya',
    });
  });

  it('skips a text post, which has no public surface to probe', () => {
    expect(hitToRawLead({ ...base, url: null })).toBeNull();
  });

  it('falls back to the story text when the title carries no tagline', () => {
    const lead = hitToRawLead({
      ...base,
      title: 'Show HN: Meterbase',
      story_text: '<p>A tiny CLI for metering usage.</p>',
    });
    expect(lead?.description).toBe('A tiny CLI for metering usage.');
    expect(lead?.tags).toContain('cli');
  });

  it('truncates a long story text', () => {
    const lead = hitToRawLead({ ...base, title: 'Show HN: Meterbase', story_text: 'x'.repeat(900) });
    expect(lead?.description?.length).toBe(500);
    expect(lead?.description?.endsWith('...')).toBe(true);
  });
});
