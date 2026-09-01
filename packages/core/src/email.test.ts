import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { hashEmail, isDisposableOrJunk, isRoleAddress, normalizeEmail } from './email';

describe('normalizeEmail', () => {
  it('lowercases and trims', () => {
    expect(normalizeEmail('  Priya@Meterbase.DEV  ')).toBe('priya@meterbase.dev');
  });

  it('strips a surrounding angle bracket pair', () => {
    expect(normalizeEmail('<priya@meterbase.dev>')).toBe('priya@meterbase.dev');
  });

  it('strips a +tag so one human hashes to one value', () => {
    expect(normalizeEmail('priya+showhn@meterbase.dev')).toBe('priya@meterbase.dev');
    expect(normalizeEmail('priya+a+b@meterbase.dev')).toBe('priya@meterbase.dev');
  });

  it('collapses a tagged and an untagged address to the same hash input', () => {
    expect(normalizeEmail('Priya+HN@Meterbase.dev')).toBe(normalizeEmail('priya@meterbase.dev'));
  });

  it('handles a mailto: with a query string', () => {
    expect(normalizeEmail('mailto:priya@meterbase.dev?subject=Hi%20there')).toBe(
      'priya@meterbase.dev',
    );
  });

  it('rejects whitespace inside the address', () => {
    expect(normalizeEmail('priya @meterbase.dev')).toBeNull();
    expect(normalizeEmail('pri ya@meterbase.dev')).toBeNull();
  });

  it('rejects more than one @', () => {
    expect(normalizeEmail('priya@meterbase@dev')).toBeNull();
    expect(normalizeEmail('a@b@c.com')).toBeNull();
  });

  it('rejects a domain with no dot', () => {
    expect(normalizeEmail('root@localhost')).toBeNull();
    expect(normalizeEmail('priya@meterbase')).toBeNull();
  });

  it('rejects a trailing dot on the domain', () => {
    expect(normalizeEmail('priya@meterbase.dev.')).toBeNull();
  });

  it('rejects an empty local part, an empty domain and consecutive dots', () => {
    expect(normalizeEmail('@meterbase.dev')).toBeNull();
    expect(normalizeEmail('priya@')).toBeNull();
    expect(normalizeEmail('priya@meterbase..dev')).toBeNull();
    expect(normalizeEmail('.priya@meterbase.dev')).toBeNull();
  });

  it('rejects a +tag that eats the whole local part', () => {
    expect(normalizeEmail('+tag@meterbase.dev')).toBeNull();
  });

  it('rejects a display name form, a numeric tld and empty input', () => {
    expect(normalizeEmail('Priya <priya@meterbase.dev>')).toBeNull();
    expect(normalizeEmail('priya@meterbase.d3v')).toBeNull();
    expect(normalizeEmail('')).toBeNull();
    expect(normalizeEmail('   ')).toBeNull();
  });

  it('rejects a list of addresses rather than picking one', () => {
    expect(normalizeEmail('a@b.com, c@d.com')).toBeNull();
  });

  it('keeps legal punctuation in the local part', () => {
    expect(normalizeEmail('morten.p_g-1@exit1.dev')).toBe('morten.p_g-1@exit1.dev');
  });
});

describe('hashEmail', () => {
  it('is an HMAC and not a bare sha256 (9.3)', () => {
    // sha256('priya@meterbase.dev') must never be the answer, otherwise the
    // hash-only claim on the suppressions table is decorative.
    const bareSha256 = '2b6a8e6a3a4e17fa2f0c4ac1a1c0c0e93c99b0f38b1a2e0e26f8f0a9b0f2f0d0';
    const hash = hashEmail('priya@meterbase.dev', 'pepper');
    expect(hash).not.toBe(bareSha256);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is stable for the same pepper and different for another', () => {
    const a = hashEmail('priya@meterbase.dev', 'pepper-one');
    const b = hashEmail('priya@meterbase.dev', 'pepper-one');
    const c = hashEmail('priya@meterbase.dev', 'pepper-two');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('matches the known HMAC-SHA256 value', () => {
    expect(hashEmail('priya@meterbase.dev', 'pepper')).toBe(
      createHmac('sha256', 'pepper').update('priya@meterbase.dev', 'utf8').digest('hex'),
    );
  });

  it('refuses to run without a pepper', () => {
    expect(() => hashEmail('priya@meterbase.dev', '')).toThrow();
  });
});

describe('isRoleAddress', () => {
  it('flags shared inboxes', () => {
    for (const local of ['info', 'support', 'sales', 'admin', 'noreply', 'no-reply']) {
      expect(isRoleAddress(`${local}@meterbase.dev`)).toBe(true);
    }
  });

  it('keeps hello@ contactable', () => {
    // On a solo founder launch hello@ is the founder's own inbox and often the
    // only address on the site.
    expect(isRoleAddress('hello@meterbase.dev')).toBe(false);
    expect(isRoleAddress('contact@meterbase.dev')).toBe(false);
  });

  it('does not flag a personal address that merely contains a role word', () => {
    expect(isRoleAddress('priya@meterbase.dev')).toBe(false);
    expect(isRoleAddress('info.priya@meterbase.dev')).toBe(false);
  });
});

describe('isDisposableOrJunk', () => {
  it('rejects the example domains and localhost', () => {
    expect(isDisposableOrJunk('priya@example.com')).toBe(true);
    expect(isDisposableOrJunk('priya@example.org')).toBe(true);
    expect(isDisposableOrJunk('priya@example.net')).toBe(true);
    expect(isDisposableOrJunk('root@localhost')).toBe(true);
  });

  it('rejects sentry ingest hosts and DSN shaped locals', () => {
    expect(isDisposableOrJunk('abc@o12345.ingest.sentry.io')).toBe(true);
    expect(isDisposableOrJunk('a1b2c3d4e5f6a7b8c9d0@self-hosted-sentry.meterbase.dev')).toBe(true);
  });

  it('rejects wixpress and disposable mailbox providers', () => {
    expect(isDisposableOrJunk('priya@wixpress.com')).toBe(true);
    expect(isDisposableOrJunk('priya@mailinator.com')).toBe(true);
  });

  it('rejects obvious placeholder addresses', () => {
    expect(isDisposableOrJunk('you@yourdomain.com')).toBe(true);
    expect(isDisposableOrJunk('name@company.com')).toBe(true);
    expect(isDisposableOrJunk('test@meterbase.dev')).toBe(true);
    expect(isDisposableOrJunk('john.doe@meterbase.dev')).toBe(true);
  });

  it('accepts a real looking founder address', () => {
    expect(isDisposableOrJunk('priya@meterbase.dev')).toBe(false);
    expect(isDisposableOrJunk('morten@exit1.dev')).toBe(false);
  });
});
