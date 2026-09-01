import { describe, expect, it } from 'vitest';
import { isPrivacyShielded, parseRdap } from './whois';

function vcard(entries: unknown[]): unknown {
  return ['vcard', [['version', {}, 'text', '4.0'], ...entries]];
}

describe('isPrivacyShielded', () => {
  it('catches the redaction boilerplate', () => {
    expect(isPrivacyShielded('REDACTED FOR PRIVACY')).toBe(true);
    expect(isPrivacyShielded('Data Protected')).toBe(true);
    expect(isPrivacyShielded('Statutory Masking Enabled')).toBe(true);
  });

  it('catches the named privacy services', () => {
    expect(isPrivacyShielded('WhoisGuard, Inc.')).toBe(true);
    expect(isPrivacyShielded('PrivacyProtect.org')).toBe(true);
    expect(isPrivacyShielded('Domains By Proxy, LLC')).toBe(true);
    expect(isPrivacyShielded('Contact Privacy Inc.')).toBe(true);
  });

  it('catches a registrar proxy mailbox', () => {
    expect(isPrivacyShielded('abc123@withheldforprivacy.com')).toBe(true);
    expect(isPrivacyShielded('x@sub.domainsbyproxy.com')).toBe(true);
  });

  it('leaves a real registrant alone', () => {
    expect(isPrivacyShielded('Priya Sharma')).toBe(false);
    expect(isPrivacyShielded('priya@meterbase.dev')).toBe(false);
  });
});

describe('parseRdap', () => {
  it('reads the registrant address and country', () => {
    const doc = {
      entities: [
        {
          roles: ['registrant'],
          vcardArray: vcard([
            ['fn', {}, 'text', 'Priya Sharma'],
            ['adr', {}, 'text', ['', '', '1 Market St', 'San Francisco', 'CA', '94105', 'US']],
            ['email', {}, 'text', 'priya@meterbase.dev'],
          ]),
        },
      ],
    };
    expect(parseRdap(doc)).toEqual({ email: 'priya@meterbase.dev', country: 'US' });
  });

  it('reads a country from the cc parameter', () => {
    const doc = {
      entities: [{ roles: ['registrant'], vcardArray: vcard([['adr', { cc: 'de' }, 'text', []]]) }],
    };
    expect(parseRdap(doc).country).toBe('DE');
  });

  it('returns nothing for a shielded record', () => {
    const doc = {
      entities: [
        {
          roles: ['registrant'],
          vcardArray: vcard([
            ['fn', {}, 'text', 'REDACTED FOR PRIVACY'],
            ['adr', {}, 'text', ['', '', '', '', '', '', 'PA']],
            ['email', {}, 'text', 'abc@withheldforprivacy.com'],
          ]),
        },
      ],
    };
    expect(parseRdap(doc)).toEqual({ email: null, country: null });
  });

  it('ignores the registrar block, which describes the registrar', () => {
    const doc = {
      entities: [
        {
          roles: ['registrar'],
          vcardArray: vcard([
            ['fn', {}, 'text', 'Big Registrar Inc'],
            ['adr', {}, 'text', ['', '', '', '', '', '', 'CA']],
            ['email', {}, 'text', 'ops@bigregistrar.example'],
          ]),
        },
      ],
    };
    expect(parseRdap(doc)).toEqual({ email: null, country: null });
  });

  it('walks nested entities', () => {
    const doc = {
      entities: [
        {
          roles: ['registrar'],
          entities: [
            {
              roles: ['administrative'],
              vcardArray: vcard([['email', {}, 'text', 'sam@meterbase.dev']]),
            },
          ],
        },
      ],
    };
    expect(parseRdap(doc).email).toBe('sam@meterbase.dev');
  });

  it('survives a record with no entities at all', () => {
    expect(parseRdap({})).toEqual({ email: null, country: null });
    expect(parseRdap(null)).toEqual({ email: null, country: null });
  });
});
