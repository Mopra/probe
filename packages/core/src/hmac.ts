import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** §6: generators reject a timestamp more than 300s old. */
const DEFAULT_TOLERANCE_SECONDS = 300;

function digest(secret: string, timestamp: number | string, rawBody: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${rawBody}`, 'utf8').digest('hex');
}

/**
 * Returns the value for X-Probe-Signature: 'sha256=<hex>'.
 * Signs `${timestamp}.${rawBody}` with the secret (§6).
 */
export function signGeneratorRequest(args: {
  secret: string;
  timestamp: number | string;
  rawBody: string;
}): string {
  if (!args.secret) throw new Error('signGeneratorRequest: secret is required');
  return `sha256=${digest(args.secret, args.timestamp, args.rawBody)}`;
}

/**
 * Constant-time compare plus a freshness window on the timestamp. Both halves
 * matter: the compare stops a byte-at-a-time forgery, the window stops an old
 * signed body being replayed forever.
 */
export function verifyGeneratorSignature(args: {
  secret: string;
  timestamp: number | string;
  rawBody: string;
  signature: string;
  nowMs?: number;
  toleranceSeconds?: number;
}): boolean {
  const { secret, timestamp, rawBody, signature } = args;
  if (!secret || typeof signature !== 'string' || signature.length === 0) return false;

  const tolerance = args.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  const nowMs = args.nowMs ?? Date.now();

  const ts = typeof timestamp === 'number' ? timestamp : Number.parseInt(String(timestamp), 10);
  if (!Number.isFinite(ts)) return false;

  // Reject a clock that is too far ahead as well as too far behind: a future
  // timestamp is either a broken sender or an attempt to mint a long-lived
  // signature.
  const skewSeconds = Math.abs(nowMs / 1000 - ts);
  if (skewSeconds > tolerance) return false;

  const expected = signGeneratorRequest({ secret, timestamp, rawBody });
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signature, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** URL-safe random token, 32 bytes, base64url. Used for unsub and click. */
export function newToken(): string {
  return randomBytes(32).toString('base64url');
}
