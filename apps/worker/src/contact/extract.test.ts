import { describe, expect, it } from 'vitest';
import {
  acceptAddress,
  deobfuscate,
  extractFromHtml,
  extractFromText,
  firstNameFrom,
  isThirdPartyAddress,
  rankCandidates,
} from './extract';

describe('deobfuscate', () => {
  it('undoes the bracketed form', () => {
    expect(deobfuscate('priya [at] meterbase [dot] dev')).toContain('priya@meterbase.dev');
  });

  it('undoes the parenthesised form', () => {
    expect(deobfuscate('priya (at) meterbase (dot) dev')).toContain('priya@meterbase.dev');
  });

  it('undoes the spelled out form', () => {
    expect(deobfuscate('write to priya at meterbase dot dev today')).toContain('priya@meterbase.dev');
  });

  it('leaves ordinary prose alone', () => {
    const prose = 'Look at this and then at that.';
    expect(deobfuscate(prose)).toBe(prose);
  });

  it('decodes numeric and named entities', () => {
    expect(deobfuscate('priya&#64;meterbase&#46;dev')).toContain('priya@meterbase.dev');
    expect(deobfuscate('priya&commat;meterbase&period;dev')).toContain('priya@meterbase.dev');
  });

  it('closes up a padded at sign', () => {
    expect(deobfuscate('priya @ meterbase.dev')).toContain('priya@meterbase.dev');
  });
});

describe('extractFromHtml', () => {
  it('finds a mailto href and strips its query', () => {
    const html = '<a href="mailto:priya@meterbase.dev?subject=Hi">Email me</a>';
    const found = extractFromHtml(html);
    expect(found).toHaveLength(1);
    expect(found[0]?.email).toBe('priya@meterbase.dev');
    expect(found[0]?.kind).toBe('mailto');
  });

  it('finds a plain text address in the body', () => {
    const found = extractFromHtml('<body><p>Reach us on priya@meterbase.dev</p></body>');
    expect(found[0]?.kind).toBe('text');
  });

  it('finds an obfuscated address the plain pass missed', () => {
    const found = extractFromHtml('<body><p>priya [at] meterbase [dot] dev</p></body>');
    expect(found).toHaveLength(1);
    expect(found[0]?.kind).toBe('obfuscated');
    expect(found[0]?.email).toBe('priya@meterbase.dev');
  });

  it('ignores addresses inside script bodies', () => {
    const html =
      '<body><script>Sentry.init({dsn:"https://abc123def4567890@o42.ingest.sentry.io/1"})</script><p>hi</p></body>';
    expect(extractFromHtml(html)).toHaveLength(0);
  });

  it('prefers the mailto entry over the same address in text', () => {
    const html = '<body><a href="mailto:priya@meterbase.dev">priya@meterbase.dev</a></body>';
    const found = extractFromHtml(html);
    expect(found).toHaveLength(1);
    expect(found[0]?.kind).toBe('mailto');
  });
});

describe('acceptAddress', () => {
  it('normalises and keeps a real address', () => {
    expect(acceptAddress('Priya+hn@Meterbase.dev')).toBe('priya@meterbase.dev');
  });

  it('rejects a role address', () => {
    expect(acceptAddress('support@meterbase.dev')).toBeNull();
  });

  it('keeps hello@, which on a solo launch is the founder', () => {
    expect(acceptAddress('hello@meterbase.dev')).toBe('hello@meterbase.dev');
  });

  it('rejects a placeholder address', () => {
    expect(acceptAddress('you@example.com')).toBeNull();
  });

  it('rejects a retina asset that looks like an address', () => {
    expect(acceptAddress('logo@2x.png')).toBeNull();
  });

  it('rejects a third party host', () => {
    expect(acceptAddress('priya@wordpress.com')).toBeNull();
    expect(acceptAddress('key@o42.ingest.sentry.io')).toBeNull();
  });

  it('keeps a personal address on a consumer mailbox', () => {
    expect(acceptAddress('priya.sharma@gmail.com')).toBe('priya.sharma@gmail.com');
  });
});

describe('isThirdPartyAddress', () => {
  it('matches subdomains of a listed host', () => {
    expect(isThirdPartyAddress('a@cdn.jsdelivr.net')).toBe(true);
  });

  it('does not match an unrelated host', () => {
    expect(isThirdPartyAddress('a@meterbase.dev')).toBe(false);
  });
});

describe('rankCandidates', () => {
  const html = `
    <body>
      <a href="mailto:priya@meterbase.dev">Priya</a>
      <a href="mailto:priya@gmail.com">personal</a>
      <p>fallback: sam@meterbase.dev</p>
    </body>`;

  it('scores a mailto on the lead domain at 90', () => {
    const ranked = rankCandidates(extractFromHtml(html), 'meterbase.dev');
    expect(ranked[0]?.emailNorm).toBe('priya@meterbase.dev');
    expect(ranked[0]?.confidence).toBe(90);
  });

  it('scores a mailto elsewhere at 70 and a scrape at 50', () => {
    const ranked = rankCandidates(extractFromHtml(html), 'meterbase.dev');
    const byEmail = new Map(ranked.map((r) => [r.emailNorm, r.confidence]));
    expect(byEmail.get('priya@gmail.com')).toBe(70);
    expect(byEmail.get('sam@meterbase.dev')).toBe(50);
  });

  it('scores a deobfuscated address at 40', () => {
    const ranked = rankCandidates(extractFromText('sam [at] meterbase [dot] dev'), 'meterbase.dev');
    expect(ranked[0]?.confidence).toBe(40);
  });

  it('puts the lead domain ahead of a higher confidence address elsewhere', () => {
    const ranked = rankCandidates(
      [
        { email: 'priya@gmail.com', kind: 'mailto', context: '' },
        { email: 'sam@meterbase.dev', kind: 'text', context: '' },
      ],
      'meterbase.dev',
    );
    expect(ranked[0]?.emailNorm).toBe('sam@meterbase.dev');
  });

  it('drops every rejected candidate', () => {
    expect(rankCandidates(extractFromHtml('<a href="mailto:info@x.com">info</a>'), 'x.com')).toEqual([]);
  });
});

describe('firstNameFrom', () => {
  it('reads a founded-by line', () => {
    expect(firstNameFrom(['Founded by Priya in 2024'], null)).toBe('Priya');
  });

  it('reads a founder attribution', () => {
    expect(firstNameFrom(['Sam Ahmed, co-founder'], null)).toBe('Sam');
  });

  it('falls back to a local part that reads as a given name', () => {
    expect(firstNameFrom([], 'priya@meterbase.dev')).toBe('Priya');
    expect(firstNameFrom([], 'priya.sharma@meterbase.dev')).toBe('Priya');
  });

  it('refuses a local part that is a function, not a person', () => {
    expect(firstNameFrom([], 'hello@meterbase.dev')).toBeNull();
    expect(firstNameFrom([], 'team@meterbase.dev')).toBeNull();
  });

  it('returns null rather than guessing', () => {
    expect(firstNameFrom(['Welcome to our website'], 'k3@meterbase.dev')).toBeNull();
  });
});
