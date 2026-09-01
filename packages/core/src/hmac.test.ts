import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { newToken, signGeneratorRequest, verifyGeneratorSignature } from './hmac';

const SECRET = 'probe-hmac-secret';
const BODY = JSON.stringify({ lead_id: '01J', product: { name: 'Meterbase' } });
const TS = 1_756_000_000;
const NOW_MS = TS * 1000;

describe('signGeneratorRequest', () => {
  it('signs timestamp + "." + rawBody and prefixes sha256=', () => {
    const expected = createHmac('sha256', SECRET).update(`${TS}.${BODY}`, 'utf8').digest('hex');
    expect(signGeneratorRequest({ secret: SECRET, timestamp: TS, rawBody: BODY })).toBe(
      `sha256=${expected}`,
    );
  });

  it('treats a numeric and a string timestamp identically', () => {
    expect(signGeneratorRequest({ secret: SECRET, timestamp: TS, rawBody: BODY })).toBe(
      signGeneratorRequest({ secret: SECRET, timestamp: String(TS), rawBody: BODY }),
    );
  });

  it('refuses to sign without a secret', () => {
    expect(() => signGeneratorRequest({ secret: '', timestamp: TS, rawBody: BODY })).toThrow();
  });
});

describe('verifyGeneratorSignature', () => {
  const signature = signGeneratorRequest({ secret: SECRET, timestamp: TS, rawBody: BODY });

  it('accepts a fresh, untampered request', () => {
    expect(
      verifyGeneratorSignature({
        secret: SECRET,
        timestamp: TS,
        rawBody: BODY,
        signature,
        nowMs: NOW_MS,
      }),
    ).toBe(true);
  });

  it('accepts inside the 300s window and rejects a stale timestamp', () => {
    const at = (offsetSeconds: number) =>
      verifyGeneratorSignature({
        secret: SECRET,
        timestamp: TS,
        rawBody: BODY,
        signature,
        nowMs: NOW_MS + offsetSeconds * 1000,
      });
    expect(at(299)).toBe(true);
    expect(at(300)).toBe(true);
    expect(at(301)).toBe(false);
    expect(at(3600)).toBe(false);
  });

  it('rejects a timestamp far in the future', () => {
    expect(
      verifyGeneratorSignature({
        secret: SECRET,
        timestamp: TS,
        rawBody: BODY,
        signature,
        nowMs: NOW_MS - 900_000,
      }),
    ).toBe(false);
  });

  it('honours a custom tolerance', () => {
    expect(
      verifyGeneratorSignature({
        secret: SECRET,
        timestamp: TS,
        rawBody: BODY,
        signature,
        nowMs: NOW_MS + 600_000,
        toleranceSeconds: 900,
      }),
    ).toBe(true);
  });

  it('rejects a tampered body', () => {
    expect(
      verifyGeneratorSignature({
        secret: SECRET,
        timestamp: TS,
        rawBody: `${BODY} `,
        signature,
        nowMs: NOW_MS,
      }),
    ).toBe(false);
  });

  it('rejects a tampered timestamp, which would otherwise be a replay', () => {
    expect(
      verifyGeneratorSignature({
        secret: SECRET,
        timestamp: TS + 1,
        rawBody: BODY,
        signature,
        nowMs: NOW_MS,
      }),
    ).toBe(false);
  });

  it('rejects the wrong secret', () => {
    expect(
      verifyGeneratorSignature({
        secret: 'not-the-secret',
        timestamp: TS,
        rawBody: BODY,
        signature,
        nowMs: NOW_MS,
      }),
    ).toBe(false);
  });

  it('rejects a malformed, empty or truncated signature without throwing', () => {
    const bad = (sig: string) =>
      verifyGeneratorSignature({
        secret: SECRET,
        timestamp: TS,
        rawBody: BODY,
        signature: sig,
        nowMs: NOW_MS,
      });
    expect(bad('')).toBe(false);
    expect(bad('sha256=')).toBe(false);
    expect(bad(signature.slice(0, -1))).toBe(false);
    expect(bad(signature.replace('sha256=', ''))).toBe(false);
  });

  it('rejects a non numeric timestamp', () => {
    expect(
      verifyGeneratorSignature({
        secret: SECRET,
        timestamp: 'not-a-number',
        rawBody: BODY,
        signature,
        nowMs: NOW_MS,
      }),
    ).toBe(false);
  });
});

describe('newToken', () => {
  it('is 32 bytes of base64url with no padding', () => {
    const token = newToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
  });

  it('does not repeat', () => {
    const tokens = new Set(Array.from({ length: 200 }, () => newToken()));
    expect(tokens.size).toBe(200);
  });
});
