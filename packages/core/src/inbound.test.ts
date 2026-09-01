import { describe, expect, it } from 'vitest';
import { isAutomatedMessage, parseFromAddress } from './inbound';
import type { Headers } from './inbound';

const GENUINE: Headers = {
  From: 'Priya Nair <priya@meterbase.dev>',
  To: 'morten@mail.exit1.dev',
  Subject: 'Re: /v1/usage returned 502 on 3 of 20 probes this morning',
  'Message-Id': '<abc@meterbase.dev>',
};

describe('isAutomatedMessage', () => {
  it('lets a genuine reply through', () => {
    expect(isAutomatedMessage(GENUINE)).toBe(false);
  });

  it('flags Auto-Submitted with any value other than no', () => {
    expect(isAutomatedMessage({ ...GENUINE, 'Auto-Submitted': 'auto-replied' })).toBe(true);
    expect(isAutomatedMessage({ ...GENUINE, 'Auto-Submitted': 'auto-generated' })).toBe(true);
    expect(isAutomatedMessage({ ...GENUINE, 'Auto-Submitted': 'auto-replied; owner=x' })).toBe(true);
  });

  it('lets Auto-Submitted: no through', () => {
    expect(isAutomatedMessage({ ...GENUINE, 'Auto-Submitted': 'no' })).toBe(false);
    expect(isAutomatedMessage({ ...GENUINE, 'auto-submitted': 'No' })).toBe(false);
  });

  it('flags bulk, auto_reply and junk Precedence', () => {
    for (const value of ['bulk', 'auto_reply', 'junk']) {
      expect(isAutomatedMessage({ ...GENUINE, Precedence: value }), value).toBe(true);
    }
  });

  it('flags the autoresponder headers regardless of value', () => {
    expect(isAutomatedMessage({ ...GENUINE, 'X-Autoresponse': 'anything' })).toBe(true);
    expect(isAutomatedMessage({ ...GENUINE, 'X-Autoreply': 'yes' })).toBe(true);
    expect(isAutomatedMessage({ ...GENUINE, 'X-Auto-Response-Suppress': 'OOF' })).toBe(true);
  });

  it('looks headers up case insensitively', () => {
    expect(isAutomatedMessage({ ...GENUINE, PRECEDENCE: 'bulk' })).toBe(true);
    expect(isAutomatedMessage({ ...GENUINE, 'x-AUTOREPLY': 'yes' })).toBe(true);
  });

  it('handles a header delivered as an array', () => {
    expect(isAutomatedMessage({ ...GENUINE, Precedence: ['bulk'] })).toBe(true);
    expect(isAutomatedMessage({ ...GENUINE, 'Auto-Submitted': ['no'] })).toBe(false);
  });

  it('flags a bounce-shaped From', () => {
    expect(isAutomatedMessage({ ...GENUINE, From: 'MAILER-DAEMON@mail.exit1.dev' })).toBe(true);
    expect(isAutomatedMessage({ ...GENUINE, From: 'Mail Delivery <postmaster@meterbase.dev>' })).toBe(
      true,
    );
  });

  it('flags the null return path used by every bounce', () => {
    expect(isAutomatedMessage({ ...GENUINE, 'Return-Path': '<>' })).toBe(true);
  });

  it('flags an out-of-office subject as a last resort', () => {
    const subjects = [
      'Out of office',
      'Automatic reply: /v1/usage returned 502',
      'Re: Out of Office until 14 September',
      'Undelivered Mail Returned to Sender',
      'Delivery Status Notification (Failure)',
    ];
    for (const Subject of subjects) {
      expect(isAutomatedMessage({ ...GENUINE, Subject }), Subject).toBe(true);
    }
  });

  it('does not treat an ordinary subject as automated', () => {
    expect(isAutomatedMessage({ ...GENUINE, Subject: 'Thanks, fixed it' })).toBe(false);
    expect(isAutomatedMessage({ ...GENUINE, Subject: 'Re: your report on our office hours' })).toBe(
      false,
    );
  });

  it('survives empty and malformed header objects', () => {
    expect(isAutomatedMessage({})).toBe(false);
    expect(isAutomatedMessage({ From: undefined, Subject: undefined })).toBe(false);
  });
});

describe('parseFromAddress', () => {
  it('pulls the address out of a display name form', () => {
    expect(parseFromAddress('Priya Nair <priya@meterbase.dev>')).toBe('priya@meterbase.dev');
    expect(parseFromAddress('"Nair, Priya" <Priya@Meterbase.DEV>')).toBe('priya@meterbase.dev');
  });

  it('prefers the angle bracket address over one in the display name', () => {
    expect(parseFromAddress('"spoof@evil.com" <priya@meterbase.dev>')).toBe('priya@meterbase.dev');
  });

  it('handles a bare address', () => {
    expect(parseFromAddress('priya@meterbase.dev')).toBe('priya@meterbase.dev');
    expect(parseFromAddress('  PRIYA@meterbase.dev  ')).toBe('priya@meterbase.dev');
  });

  it('keeps the +tag for normalizeEmail to strip', () => {
    expect(parseFromAddress('Priya <priya+hn@meterbase.dev>')).toBe('priya+hn@meterbase.dev');
  });

  it('returns null for the null sender and for junk', () => {
    expect(parseFromAddress('<>')).toBeNull();
    expect(parseFromAddress('')).toBeNull();
    expect(parseFromAddress(undefined)).toBeNull();
    expect(parseFromAddress('Priya Nair')).toBeNull();
    expect(parseFromAddress('priya@localhost')).toBeNull();
  });
});
