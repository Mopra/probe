import { describe, expect, it } from 'vitest';
import { isHttps, isPlatformDomain, normalizeDomain, normalizeUrl } from './url';

describe('normalizeDomain', () => {
  it('lowercases the host and drops www', () => {
    expect(normalizeDomain('https://WWW.Meterbase.dev')).toBe('meterbase.dev');
  });

  it('drops port, path, query and fragment', () => {
    expect(normalizeDomain('https://meterbase.dev:8443/pricing?utm_source=hn#top')).toBe(
      'meterbase.dev',
    );
  });

  it('collapses the forms a directory sweep actually produces to one key', () => {
    // This is what makes leads_domain_uniq work: the same product on three
    // directories must be one lead (8.1).
    const forms = [
      'https://meterbase.dev',
      'http://meterbase.dev/',
      'https://www.meterbase.dev/launch',
      'HTTPS://WWW.METERBASE.DEV/?ref=producthunt',
      'meterbase.dev',
      'https://meterbase.dev.',
    ];
    const domains = new Set(forms.map((f) => normalizeDomain(f)));
    expect([...domains]).toEqual(['meterbase.dev']);
  });

  it('keeps a subdomain that is not www', () => {
    expect(normalizeDomain('https://app.meterbase.dev')).toBe('app.meterbase.dev');
  });

  it('rejects IP literals', () => {
    expect(normalizeDomain('https://192.168.0.1/')).toBeNull();
    expect(normalizeDomain('http://127.0.0.1:3000')).toBeNull();
    expect(normalizeDomain('https://[::1]/')).toBeNull();
  });

  it('rejects a host with no dot', () => {
    expect(normalizeDomain('http://localhost:3000')).toBeNull();
    expect(normalizeDomain('https://intranet')).toBeNull();
  });

  it('rejects non http(s) schemes and junk', () => {
    expect(normalizeDomain('ftp://meterbase.dev')).toBeNull();
    expect(normalizeDomain('mailto:priya@meterbase.dev')).toBeNull();
    expect(normalizeDomain('javascript:alert(1)')).toBeNull();
    expect(normalizeDomain('')).toBeNull();
    expect(normalizeDomain('not a url')).toBeNull();
  });

  it('rejects a numeric tld', () => {
    expect(normalizeDomain('https://meterbase.12')).toBeNull();
  });
});

describe('normalizeUrl', () => {
  it('forces https and normalizes the host', () => {
    expect(normalizeUrl('http://WWW.Meterbase.dev')).toBe('https://meterbase.dev');
  });

  it('drops the trailing slash on a bare root only', () => {
    expect(normalizeUrl('https://meterbase.dev/')).toBe('https://meterbase.dev');
    expect(normalizeUrl('https://meterbase.dev/docs/')).toBe('https://meterbase.dev/docs/');
  });

  it('preserves the path', () => {
    expect(normalizeUrl('https://meterbase.dev/docs/v1/usage')).toBe(
      'https://meterbase.dev/docs/v1/usage',
    );
  });

  it('drops utm_*, ref, fbclid and gclid but keeps real params', () => {
    expect(
      normalizeUrl('https://meterbase.dev/p?utm_source=hn&utm_medium=x&ref=ph&fbclid=1&gclid=2&id=7'),
    ).toBe('https://meterbase.dev/p?id=7');
  });

  it('drops the query entirely when it was all tracking', () => {
    expect(normalizeUrl('https://meterbase.dev/?utm_campaign=launch')).toBe(
      'https://meterbase.dev',
    );
  });

  it('drops the fragment', () => {
    expect(normalizeUrl('https://meterbase.dev/docs#pricing')).toBe('https://meterbase.dev/docs');
  });

  it('returns null for anything unusable', () => {
    expect(normalizeUrl('ftp://meterbase.dev')).toBeNull();
    expect(normalizeUrl('http://localhost:3000')).toBeNull();
    expect(normalizeUrl('https://10.0.0.5/app')).toBeNull();
    expect(normalizeUrl('')).toBeNull();
  });
});

describe('isHttps', () => {
  it('is true only when the input itself declares https', () => {
    expect(isHttps('https://meterbase.dev')).toBe(true);
    expect(isHttps('  https://meterbase.dev/docs  ')).toBe(true);
    expect(isHttps('HTTPS://meterbase.dev')).toBe(true);
  });

  it('is false for http, a bare domain and junk', () => {
    expect(isHttps('http://meterbase.dev')).toBe(false);
    expect(isHttps('meterbase.dev')).toBe(false);
    expect(isHttps('https://localhost:3000')).toBe(false);
    expect(isHttps('')).toBe(false);
  });
});

describe('isPlatformDomain', () => {
  it('catches the platforms Show HN links to constantly', () => {
    expect(isPlatformDomain('github.com')).toBe(true);
    expect(isPlatformDomain('twitter.com')).toBe(true);
    expect(isPlatformDomain('medium.com')).toBe(true);
    expect(isPlatformDomain('apps.apple.com')).toBe(true);
    expect(isPlatformDomain('producthunt.com')).toBe(true);
  });

  it('catches somebody\'s project page under a platform parent', () => {
    expect(isPlatformDomain('doruksega.github.io')).toBe(true);
    expect(isPlatformDomain('hengmhs.pyscriptapps.com')).toBe(true);
    expect(isPlatformDomain('wasm-gguf.netlify.app')).toBe(true);
    expect(isPlatformDomain('eito.substack.com')).toBe(true);
    // The parent itself, not only its children.
    expect(isPlatformDomain('github.io')).toBe(true);
  });

  it('leaves real products alone', () => {
    expect(isPlatformDomain('meterbase.dev')).toBe(false);
    expect(isPlatformDomain('noisevanish.com')).toBe(false);
    expect(isPlatformDomain('exit1.dev')).toBe(false);
    // Substring, not a suffix on a label boundary: notgithub.com is a product.
    expect(isPlatformDomain('notgithub.com')).toBe(false);
    expect(isPlatformDomain('mygithub.iofoo.com')).toBe(false);
  });

  it('handles junk input without throwing', () => {
    expect(isPlatformDomain(null)).toBe(false);
    expect(isPlatformDomain('')).toBe(false);
    expect(isPlatformDomain('   ')).toBe(false);
    expect(isPlatformDomain('GITHUB.COM')).toBe(true);
    expect(isPlatformDomain('github.com.')).toBe(true);
  });
});
