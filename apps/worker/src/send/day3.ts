// The Day3 transactional API client (§5.1).
//
// probe does not talk to SES. Day3 does, on the same AWS account and the same
// verified sending domains that already carry exit1's mail, which is why this
// replaced a separate AWS account, a separate SES production-access request and
// a separate set of DKIM/MAIL FROM/DMARC records. What probe gives up is direct
// control of the MIME envelope; what it gets is a provider boundary that is
// already warmed, already monitored and already has a suppression list.
//
// Three properties of the Day3 API are load bearing here and none of them are
// optional:
//
//   1. `Idempotency-Key`. probe sends the send row's own id, so a retry after a
//      timeout replays the original response instead of mailing a founder
//      twice. This is the second half of the contact-once guarantee: the atomic
//      claim in claimNextDueSend stops two probe processes racing, and this
//      stops one process double-sending across an ambiguous network failure.
//   2. `list_unsubscribe`. RFC 8058 one-click is not negotiable for cold
//      outreach (§9.3), and Day3 reserves the raw header names, so this
//      dedicated field is the only door to them. It also validates the URL,
//      which is why a localhost base url fails here loudly rather than shipping
//      a dead unsubscribe link.
//   3. The synchronous error envelope. Day3 answers with a documented code, so
//      a refusal that probe should never retry (`domain_not_verified`,
//      `email_suppressed`) is distinguishable from one it should.

import { logger } from '@probe/config';
import { sleep } from '../lib/http';

const log = logger('send.day3');

export interface Day3Error {
  code: string;
  message: string;
  param?: string;
  requestId?: string;
}

export interface Day3SendResult {
  /** The Day3 transactional email id, `eml_…`. */
  emailId: string;
  status: string;
}

export class Day3SendError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /**
     * False for a refusal probe must not retry: the domain is not verified, the
     * address is suppressed, the account cannot send. Retrying those burns the
     * send's attempts for nothing and, in the suppressed case, is the one thing
     * §3.1 rule 2 forbids.
     */
     readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'Day3SendError';
  }
}

export interface Day3SendInput {
  /** 'Morten Pradsgaard <morten@mail.exit1.dev>' or a bare address. */
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
  /** The /u/:token URL. Day3 builds the RFC 8058 header pair from it. */
  listUnsubscribe: string;
  tags?: Record<string, string>;
}

export interface Day3ClientConfig {
  apiKey: string;
  baseUrl: string;
  timeoutMs?: number;
  maxAttempts?: number;
  fetchImpl?: typeof fetch;
  /** Test seam so a retry test does not actually wait. */
  sleepImpl?: (ms: number) => Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_ATTEMPTS = 4;

/**
 * Codes Day3 returns that mean "this will never work, stop asking". Everything
 * else on a 4xx is also terminal (a 400 is a bug in probe, not a blip), but
 * these are the ones worth naming because the operator will see them.
 */
const TERMINAL_CODES = new Set([
  'domain_not_verified',
  'email_suppressed',
  'sending_disabled',
  'plan_limit_reached',
  'sandbox_recipient_not_allowed',
  'invalid_api_key',
  'revoked_api_key',
  'invalid_email',
  'invalid_request',
  'forbidden',
]);

function parseError(status: number, body: string): Day3Error {
  try {
    const parsed = JSON.parse(body) as {
      error?: { code?: string; message?: string; param?: string; request_id?: string };
    };
    if (parsed?.error?.code) {
      return {
        code: parsed.error.code,
        message: parsed.error.message ?? '',
        param: parsed.error.param,
        requestId: parsed.error.request_id,
      };
    }
  } catch {
    // Non-JSON body. Fall through to the generic shape.
  }
  return { code: `http_${status}`, message: body.slice(0, 400) };
}

/**
 * One send through Day3, with retries.
 *
 * `idempotencyKey` must be the send row's id and nothing else. It is what makes
 * a retry safe, and Day3 answers a replay with the original response, so a
 * successful retry returns the same `eml_…` id rather than a second email.
 */
export async function day3Send(
  config: Day3ClientConfig,
  input: Day3SendInput,
  idempotencyKey: string,
): Promise<Day3SendResult> {
  const doFetch = config.fetchImpl ?? globalThis.fetch;
  if (typeof doFetch !== 'function') {
    throw new Day3SendError(0, 'no_fetch', 'no fetch implementation available', false);
  }
  const nap = config.sleepImpl ?? sleep;
  const maxAttempts = Math.max(1, config.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const url = `${config.baseUrl.replace(/\/+$/, '')}/api/v1/emails`;

  const body = JSON.stringify({
    from: input.from,
    to: input.to,
    subject: input.subject,
    html: input.html,
    text: input.text,
    ...(input.replyTo ? { reply_to: input.replyTo } : {}),
    list_unsubscribe: input.listUnsubscribe,
    ...(input.tags ? { tags: input.tags } : {}),
  });

  let last: Day3SendError | null = null;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    let status = 0;
    let text = '';
    let retryAfterS: number | null = null;

    try {
      const res = await doFetch(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${config.apiKey}`,
          'content-type': 'application/json',
          accept: 'application/json',
          // Deterministic for this send, forever. Day3 holds the claim for 24h.
          'idempotency-key': idempotencyKey,
        },
        body,
        signal: AbortSignal.timeout(config.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
      status = res.status;
      text = await res.text();

      if (res.ok) {
        let parsed: { id?: unknown; status?: unknown } | null = null;
        try {
          parsed = JSON.parse(text) as { id?: unknown; status?: unknown };
        } catch {
          parsed = null;
        }
        const emailId = typeof parsed?.id === 'string' ? parsed.id : null;
        if (!emailId) {
          // A 2xx with no id is unusable: probe would have no join key for the
          // webhook and no way to prove what happened. Terminal, and loud.
          throw new Day3SendError(
            status,
            'no_email_id',
            'Day3 accepted the message but returned no email id',
            false,
          );
        }
        return {
          emailId,
          status: typeof parsed?.status === 'string' ? parsed.status : 'queued',
        };
      }

      const header = res.headers.get('retry-after');
      if (header) retryAfterS = Number(header);
    } catch (err) {
      if (err instanceof Day3SendError) throw err;
      // Network, DNS, or the abort timeout. Ambiguous: the request may have
      // reached Day3. Retryable only because the idempotency key makes a replay
      // a replay rather than a second send.
      status = 0;
      text = err instanceof Error ? err.message : String(err);
    }

    const error = status === 0 ? { code: 'network_error', message: text } : parseError(status, text);

    // idempotency_conflict means the original request is still in flight behind
    // this key. Waiting it out and replaying is the correct move, on a slower
    // schedule than a plain retry so the replay lands after the original settles.
    const conflict = error.code === 'idempotency_conflict';
    const retryable =
      conflict || status === 0 || status === 429 || status >= 500 || !TERMINAL_CODES.has(error.code);

    last = new Day3SendError(
      status,
      error.code,
      error.message || `Day3 returned ${status}`,
      retryable,
    );

    if (!retryable || attempt === maxAttempts - 1) break;

    const waitMs = conflict
      ? [2_000, 5_000, 12_000][Math.min(attempt, 2)]
      : status === 429
        ? Math.min(Number.isFinite(retryAfterS ?? NaN) ? (retryAfterS as number) : 2, 30) * 1000
        : 2 ** attempt * 1_000;

    log.warn('Day3 send failed, retrying', {
      status,
      code: error.code,
      attempt: attempt + 1,
      waitMs,
      idempotencyKey,
    });
    await nap(waitMs);
  }

  throw last ?? new Day3SendError(0, 'unknown', 'Day3 send failed with no error recorded', false);
}
