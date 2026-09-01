import { createHmac, timingSafeEqual } from 'node:crypto';

// PLAN.md §5.1 and §8.7. probe does not talk to SES: it sends through the Day3
// transactional API, and Day3 reports what happened to each message over a
// signed webhook. This module is the receiving half of that contract, and it is
// the security boundary around every suppression write that a bounce or a
// complaint causes, so it is deliberately strict and it fails closed.
//
// The scheme is Day3's (Stripe-shaped):
//
//   Day3-Signature: t=<unix seconds>,v1=<hex hmac-sha256>
//
// where the MAC is over `${t}.${rawBody}` with the endpoint's `whsec_…` secret.
// Including `t` in the signed string is what makes replay bounded: an attacker
// cannot re-date a captured payload without invalidating the MAC.

export const DAY3_SIGNATURE_HEADER = 'day3-signature';
export const DAY3_EVENT_ID_HEADER = 'day3-event-id';
export const DAY3_EVENT_TYPE_HEADER = 'day3-event-type';

/** Day3 signs with a 300s window; matching it keeps replay to that window. */
const DEFAULT_TOLERANCE_SECONDS = 300;

/** The exact string the MAC covers. Exported so a test cannot drift from it. */
export function day3SigningPayload(timestampSeconds: number, rawBody: string): string {
  return `${timestampSeconds}.${rawBody}`;
}

export function computeDay3Signature(
  secret: string,
  timestampSeconds: number,
  rawBody: string,
): string {
  return createHmac('sha256', secret)
    .update(day3SigningPayload(timestampSeconds, rawBody), 'utf8')
    .digest('hex');
}

function hexEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
}

/**
 * Verifies a `Day3-Signature` header over the raw request bytes. Never throws.
 *
 * Fails closed on a missing secret. A webhook route that accepted unsigned
 * deliveries because the secret was unset would let anyone who found the URL
 * write suppressions and fake deliveries, and the URL is not a secret.
 */
export function verifyDay3Signature(args: {
  header: string | null | undefined;
  secret: string | null | undefined;
  rawBody: string;
  nowMs?: number;
  toleranceSeconds?: number;
}): boolean {
  const { header, secret, rawBody } = args;
  if (!secret || typeof secret !== 'string' || secret.length === 0) return false;
  if (!header || typeof header !== 'string') return false;

  let timestamp: number | undefined;
  const signatures: string[] = [];
  for (const part of header.split(',')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === 't') timestamp = Number(value);
    // Collect every v1 element: a secret rotation legitimately sends two.
    else if (key === 'v1') signatures.push(value);
  }
  if (timestamp === undefined || !Number.isFinite(timestamp)) return false;
  if (signatures.length === 0) return false;

  const tolerance = args.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  if (tolerance > 0) {
    const nowSeconds = (args.nowMs ?? Date.now()) / 1000;
    if (Math.abs(nowSeconds - timestamp) > tolerance) return false;
  }

  const expected = computeDay3Signature(secret, timestamp, rawBody);
  return signatures.some((candidate) => hexEqual(candidate, expected));
}

// ---------------------------------------------------------------------------
// events
// ---------------------------------------------------------------------------

/**
 * The Day3 event types probe subscribes to. `email.sent` is not among them:
 * probe already records its own send event at dispatch, and Day3's confirms
 * only what probe watched happen.
 */
export type Day3EventType =
  | 'email.delivered'
  | 'email.bounced'
  | 'email.complained'
  | 'email.failed'
  | 'suppression.created';

/** probe's own event vocabulary, which `events.type` already uses (§7). */
export type ProbeEventType = 'delivery' | 'bounce' | 'complaint' | 'failed' | 'suppression';

export interface Day3Event {
  /** Day3's event id. Stable across redeliveries, so it dedupes them. */
  id: string | null;
  type: ProbeEventType | 'unknown';
  raw: string;
  /** The Day3 transactional email id (`eml_…`), our join key back to a send. */
  emailId: string | null;
  /** SES message id, when Day3 has one. */
  providerMessageId: string | null;
  /** The address this event is about. */
  email: string | null;
  /**
   * True only for a permanent bounce or any complaint (§3.1 rule 2, §5.5).
   *
   * A Transient bounce is a full mailbox or a greylist, and suppressing on it
   * throws away a real lead. It is recorded and never acted on, which also
   * keeps the §5.5 hard-bounce rate honest: counting soft bounces against a 3%
   * hard-bounce threshold would auto-pause a campaign for someone's holiday
   * autoresponder filling an inbox.
   */
  suppress: boolean;
  reason: 'bounced' | 'complained' | null;
  /** 'Permanent' | 'Transient' | 'Undetermined', as Day3 relays it from SES. */
  bounceType: string | null;
  detail: Record<string, unknown>;
}

const KIND_BY_TYPE: Record<string, ProbeEventType> = {
  'email.delivered': 'delivery',
  'email.bounced': 'bounce',
  'email.complained': 'complaint',
  'email.failed': 'failed',
  'suppression.created': 'suppression',
};

const UNKNOWN: Omit<Day3Event, 'raw'> = {
  id: null,
  type: 'unknown',
  emailId: null,
  providerMessageId: null,
  email: null,
  suppress: false,
  reason: null,
  bounceType: null,
  detail: {},
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Parses a Day3 webhook body into probe's own event shape. Never throws: a
 * route that throws on an unexpected payload is a route that gets the same
 * payload redelivered forever.
 *
 * Day3's envelope is flat: { id, type, created_at, data }.
 */
export function parseDay3Event(rawBody: string): Day3Event {
  if (typeof rawBody !== 'string' || rawBody.trim().length === 0) {
    return { ...UNKNOWN, raw: rawBody ?? '' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return { ...UNKNOWN, raw: rawBody };
  }

  const root = asRecord(parsed);
  if (!root) return { ...UNKNOWN, raw: rawBody };

  const id = asString(root['id']);
  const rawType = asString(root['type']);
  const type = rawType ? KIND_BY_TYPE[rawType] : undefined;
  const data = asRecord(root['data']) ?? {};

  if (!type) {
    return {
      ...UNKNOWN,
      raw: rawBody,
      id,
      detail: rawType ? { type: rawType } : {},
    };
  }

  const email = asString(data['email']);
  const emailId = asString(data['email_id']);
  const providerMessageId = asString(data['provider_message_id']);
  const bounceType = asString(data['bounce_type']);

  // A bounce suppresses only when SES called it Permanent. 'Undetermined' is
  // deliberately NOT suppressed here even though Day3's own list treats it as
  // one: probe's cost of a wrong suppression is a lead it can never contact
  // again, and it has no resubscribe path (§3.1 rule 2).
  const permanent = bounceType === 'Permanent';
  const suppress = type === 'complaint' || (type === 'bounce' && permanent);

  return {
    id,
    type,
    raw: rawBody,
    emailId,
    providerMessageId,
    email,
    suppress,
    reason: suppress ? (type === 'complaint' ? 'complained' : 'bounced') : null,
    bounceType,
    detail: {
      day3_event_id: id,
      day3_event_type: rawType,
      email_id: emailId,
      provider_message_id: providerMessageId,
      ...(type === 'bounce'
        ? { bounce_type: bounceType, bounce_subtype: asString(data['bounce_subtype']) }
        : {}),
      ...(type === 'failed' ? { error: asString(data['error']) } : {}),
      ...(type === 'suppression'
        ? { reason: asString(data['reason']), source: asString(data['source']) }
        : {}),
      subject: asString(data['subject']),
    },
  };
}
