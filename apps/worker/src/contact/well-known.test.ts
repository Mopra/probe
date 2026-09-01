import { describe, expect, it } from 'vitest';
import { parseContactFields } from './well-known';

describe('parseContactFields', () => {
  it('reads a mailto contact from a security.txt', () => {
    const body = ['Contact: mailto:security@meterbase.dev', 'Expires: 2027-01-01T00:00:00.000Z'].join('\n');
    expect(parseContactFields(body)).toEqual(['security@meterbase.dev']);
  });

  it('is case insensitive on the field name and the scheme', () => {
    expect(parseContactFields('CONTACT: MAILTO:priya@meterbase.dev')).toEqual(['priya@meterbase.dev']);
  });

  it('keeps every contact line, in order', () => {
    const body = 'Contact: mailto:a@x.dev\nContact: mailto:b@x.dev\n';
    expect(parseContactFields(body)).toEqual(['a@x.dev', 'b@x.dev']);
  });

  it('skips a contact that is not an address', () => {
    const body = 'Contact: https://meterbase.dev/security\nContact: tel:+15551234567\n';
    expect(parseContactFields(body)).toEqual([]);
  });

  it('skips comments and blank lines', () => {
    expect(parseContactFields('# Contact: mailto:nope@x.dev\n\n')).toEqual([]);
  });

  it('handles CRLF line endings', () => {
    expect(parseContactFields('Contact: mailto:a@x.dev\r\nEncryption: https://x.dev/pgp\r\n')).toEqual([
      'a@x.dev',
    ]);
  });

  it('returns nothing for a humans.txt with no contact field', () => {
    expect(parseContactFields('/* TEAM */\n\tDeveloper: Priya\n\tSite: meterbase.dev\n')).toEqual([]);
  });
});
