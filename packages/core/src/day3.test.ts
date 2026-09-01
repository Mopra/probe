import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  computeDay3Signature,
  day3SigningPayload,
  parseDay3Event,
  verifyDay3Signature,
} from './day3';

const SECRET = 'whsec_test_0123456789abcdef';
const NOW_MS = 1_788_000_000_000;
const NOW_S = Math.floor(NOW_MS / 1000);

function header(body: string, opts: { secret?: string; t?: number } = {}): string {
  const t = opts.t ?? NOW_S;
  return `t=${t},v1=${computeDay3Signature(opts.secret ?? SECRET, t, body)}`;
}

describe('the signed string', () => {
  it('is `${t}.${rawBody}` and nothing else', () => {
    // Day3 signs this exact shape. If it ever drifts, every delivery is rejected
    // and bounces stop reaching the suppression list, so it is asserted directly
    // rather than only through verify().
    expect(day3SigningPayload(1700, '{"a":1}')).toBe('1700.{"a":1}');
    const expected = createHmac('sha256', SECRET).update('1700.{"a":1}').digest('hex');
    expect(computeDay3Signature(SECRET, 1700, '{"a":1}')).toBe(expected);
  });
});

describe('verifyDay3Signature', () => {
  const body = '{"id":"evt_1","type":"email.delivered","data":{}}';

  it('accepts a correctly signed body', () => {
    expect(
      verifyDay3Signature({ header: header(body), secret: SECRET, rawBody: body, nowMs: NOW_MS }),
    ).toBe(true);
  });

  it('rejects a body that changed by one byte', () => {
    expect(
      verifyDay3Signature({
        header: header(body),
        secret: SECRET,
        rawBody: `${body} `,
        nowMs: NOW_MS,
      }),
    ).toBe(false);
  });

  it('rejects the wrong secret', () => {
    expect(
      verifyDay3Signature({
        header: header(body, { secret: 'whsec_someone_else' }),
        secret: SECRET,
        rawBody: body,
        nowMs: NOW_MS,
      }),
    ).toBe(false);
  });

  it('fails closed with no secret configured', () => {
    // The endpoint URL is not a secret. An unsigned-accepting webhook would let
    // anyone who found it write permanent suppressions (§3.1 rule 2).
    for (const secret of [undefined, null, '']) {
      expect(verifyDay3Signature({ header: header(body), secret, rawBody: body, nowMs: NOW_MS })).toBe(
        false,
      );
    }
  });

  it('rejects a replay outside the tolerance window', () => {
    const stale = header(body, { t: NOW_S - 400 });
    expect(verifyDay3Signature({ header: stale, secret: SECRET, rawBody: body, nowMs: NOW_MS })).toBe(
      false,
    );
    // Inside the window it still verifies, so the bound is the only thing
    // rejecting it.
    expect(
      verifyDay3Signature({
        header: stale,
        secret: SECRET,
        rawBody: body,
        nowMs: NOW_MS,
        toleranceSeconds: 600,
      }),
    ).toBe(true);
  });

  it('rejects a re-dated timestamp, because t is inside the MAC', () => {
    const original = header(body, { t: NOW_S - 400 });
    const redated = original.replace(`t=${NOW_S - 400}`, `t=${NOW_S}`);
    expect(
      verifyDay3Signature({ header: redated, secret: SECRET, rawBody: body, nowMs: NOW_MS }),
    ).toBe(false);
  });

  it('accepts either signature during a secret rotation', () => {
    // Day3 may send two v1 elements while a secret is being rotated. Accepting
    // any of them is what stops a rotation dropping events on the floor.
    const t = NOW_S;
    const mine = computeDay3Signature(SECRET, t, body);
    const other = computeDay3Signature('whsec_the_old_one', t, body);
    expect(
      verifyDay3Signature({
        header: `t=${t},v1=${other},v1=${mine}`,
        secret: SECRET,
        rawBody: body,
        nowMs: NOW_MS,
      }),
    ).toBe(true);
  });

  it('rejects malformed headers rather than throwing', () => {
    for (const bad of [undefined, null, '', 'garbage', 't=abc,v1=def', `v1=${'a'.repeat(64)}`, `t=${NOW_S}`]) {
      expect(
        verifyDay3Signature({ header: bad, secret: SECRET, rawBody: body, nowMs: NOW_MS }),
        String(bad),
      ).toBe(false);
    }
  });
});

describe('parseDay3Event', () => {
  function event(type: string, data: Record<string, unknown> = {}): string {
    return JSON.stringify({ id: 'evt_1', type, created_at: '2026-09-01T06:00:00Z', data });
  }

  it('maps Day3 event types onto probe event types', () => {
    expect(parseDay3Event(event('email.delivered')).type).toBe('delivery');
    expect(parseDay3Event(event('email.bounced')).type).toBe('bounce');
    expect(parseDay3Event(event('email.complained')).type).toBe('complaint');
    expect(parseDay3Event(event('email.failed')).type).toBe('failed');
    expect(parseDay3Event(event('suppression.created')).type).toBe('suppression');
  });

  it('pulls out the join keys and the address', () => {
    const parsed = parseDay3Event(
      event('email.delivered', {
        object: 'email',
        email_id: 'eml_abc',
        provider_message_id: '0100018f',
        email: 'priya@meterbase.dev',
        subject: 'a finding',
      }),
    );
    expect(parsed.emailId).toBe('eml_abc');
    expect(parsed.providerMessageId).toBe('0100018f');
    expect(parsed.email).toBe('priya@meterbase.dev');
  });

  it('suppresses on a permanent bounce and NOT on a transient one', () => {
    // §5.5's threshold is a hard bounce rate. A transient bounce is a full
    // mailbox or a greylist, and suppressing on it throws away a real lead that
    // has no resubscribe path.
    const permanent = parseDay3Event(
      event('email.bounced', { email: 'a@b.com', bounce_type: 'Permanent' }),
    );
    expect(permanent.suppress).toBe(true);
    expect(permanent.reason).toBe('bounced');

    for (const bounceType of ['Transient', 'Undetermined', null, undefined]) {
      const soft = parseDay3Event(event('email.bounced', { email: 'a@b.com', bounce_type: bounceType }));
      expect(soft.suppress, String(bounceType)).toBe(false);
      expect(soft.reason, String(bounceType)).toBeNull();
      // Still recorded, so a soft bounce stays visible on /sends.
      expect(soft.type).toBe('bounce');
    }
  });

  it('suppresses on every complaint, with no exceptions', () => {
    const parsed = parseDay3Event(event('email.complained', { email: 'a@b.com' }));
    expect(parsed.suppress).toBe(true);
    expect(parsed.reason).toBe('complained');
  });

  it('never suppresses on a delivery or a failure', () => {
    expect(parseDay3Event(event('email.delivered', { email: 'a@b.com' })).suppress).toBe(false);
    // A failure means the message never left, so the address learned nothing
    // about us and has not opted out of anything.
    expect(parseDay3Event(event('email.failed', { email: 'a@b.com' })).suppress).toBe(false);
  });

  it('keeps the bounce type in the detail bag, which the rate query reads', () => {
    const parsed = parseDay3Event(
      event('email.bounced', { email: 'a@b.com', bounce_type: 'Transient', bounce_subtype: 'MailboxFull' }),
    );
    // stats.ts filters on detail->>'bounce_type' = 'Permanent', so the key name
    // here is load bearing.
    expect(parsed.detail.bounce_type).toBe('Transient');
    expect(parsed.detail.bounce_subtype).toBe('MailboxFull');
  });

  it('returns unknown rather than throwing on anything unexpected', () => {
    for (const body of ['', '   ', 'not json', '[]', 'null', '{}', JSON.stringify({ type: 'email.opened' })]) {
      const parsed = parseDay3Event(body);
      expect(parsed.type, body).toBe('unknown');
      expect(parsed.suppress, body).toBe(false);
    }
  });
});
