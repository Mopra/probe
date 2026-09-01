import { z } from 'zod';
import { signGeneratorRequest } from './hmac';

/** §6. probe never writes copy. It asks a product for a finding. */
export interface GeneratorRequest {
  lead_id: string;
  product: {
    name: string;
    url: string;
    description: string | null;
    source: string;
    launched_at: string | null;
    tags: string[];
  };
  // Deliberately no email address: a generator bug cannot leak contact data.
  recipient: { first_name: string | null };
}

export interface GeneratorReady {
  status: 'ready';
  severity: number;
  subject: string;
  html: string;
  text: string;
  fix: string;
  evidence_url: string;
  meta?: Record<string, unknown>;
}

export interface GeneratorPending {
  status: 'pending';
  retry_after?: number;
}

export const GeneratorRequestSchema: z.ZodType<GeneratorRequest> = z.object({
  lead_id: z.string().min(1),
  product: z.object({
    name: z.string().min(1),
    url: z.string().min(1),
    description: z.string().nullable(),
    source: z.string().min(1),
    launched_at: z.string().nullable(),
    tags: z.array(z.string()),
  }),
  recipient: z.object({ first_name: z.string().nullable() }),
});

export const GeneratorReadySchema: z.ZodType<GeneratorReady> = z.object({
  status: z.literal('ready'),
  severity: z.number().int(),
  subject: z.string(),
  html: z.string(),
  text: z.string(),
  fix: z.string(),
  evidence_url: z.string(),
  meta: z.record(z.unknown()).optional(),
});

export const GeneratorPendingSchema: z.ZodType<GeneratorPending> = z.object({
  status: z.literal('pending'),
  retry_after: z.number().optional(),
});

export type GeneratorOutcome =
  | { kind: 'ready'; body: GeneratorReady }
  | { kind: 'pending'; retryAfterMs: number }
  /** 204, or a finding weaker than the bar. `severity` when we saw one. */
  | { kind: 'no_proof'; severity?: number }
  | { kind: 'error'; status?: number; message: string };

/** §6: probe honours retry_after, clamped to 60 to 1800 seconds. */
export const RETRY_AFTER_MIN_MS = 60_000;
export const RETRY_AFTER_MAX_MS = 1_800_000;

const RETRY_AFTER_DEFAULT_MS = 300_000;

function clampRetryAfterMs(retryAfterSeconds: unknown): number {
  if (typeof retryAfterSeconds !== 'number' || !Number.isFinite(retryAfterSeconds)) {
    return RETRY_AFTER_DEFAULT_MS;
  }
  const ms = Math.round(retryAfterSeconds * 1000);
  if (ms < RETRY_AFTER_MIN_MS) return RETRY_AFTER_MIN_MS;
  if (ms > RETRY_AFTER_MAX_MS) return RETRY_AFTER_MAX_MS;
  return ms;
}

function describe(err: unknown): string {
  if (err instanceof Error) {
    return err.name && err.name !== 'Error' ? `${err.name}: ${err.message}` : err.message;
  }
  return String(err);
}

/**
 * One HTTP call to a generator. Signs the exact bytes it sends, honours the
 * timeout, validates the response and clamps retry_after. Never throws for a
 * transport or protocol failure: returns { kind: 'error' }.
 */
export async function callGenerator(args: {
  url: string;
  secret: string;
  request: GeneratorRequest;
  timeoutMs: number;
  minSeverity: number;
  fetchImpl?: typeof fetch;
}): Promise<GeneratorOutcome> {
  const { url, secret, request, timeoutMs, minSeverity } = args;
  const doFetch = args.fetchImpl ?? globalThis.fetch;
  if (typeof doFetch !== 'function') {
    return { kind: 'error', message: 'no fetch implementation available' };
  }

  // Serialise once and sign that exact string, then send that exact string.
  // Re-serialising between signing and sending is how signature bugs happen.
  let rawBody: string;
  try {
    rawBody = JSON.stringify(request);
  } catch (err) {
    return { kind: 'error', message: `request is not serialisable: ${describe(err)}` };
  }

  const timestamp = Math.floor(Date.now() / 1000);
  let signature: string;
  try {
    signature = signGeneratorRequest({ secret, timestamp, rawBody });
  } catch (err) {
    return { kind: 'error', message: describe(err) };
  }

  let res: Response;
  try {
    res = await doFetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-Probe-Timestamp': String(timestamp),
        'X-Probe-Signature': signature,
      },
      body: rawBody,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    return { kind: 'error', message: describe(err) };
  }

  const status = res.status;

  // 204: nothing found. Not an error; §6 expects this to be the majority.
  if (status === 204) return { kind: 'no_proof' };

  let bodyText = '';
  try {
    bodyText = await res.text();
  } catch (err) {
    return { kind: 'error', status, message: `could not read body: ${describe(err)}` };
  }

  if (status === 202) {
    let retryAfter: unknown;
    try {
      const parsed: unknown = bodyText.trim().length > 0 ? JSON.parse(bodyText) : {};
      const pending = GeneratorPendingSchema.safeParse(parsed);
      retryAfter = pending.success ? pending.data.retry_after : undefined;
    } catch {
      retryAfter = undefined;
    }
    return { kind: 'pending', retryAfterMs: clampRetryAfterMs(retryAfter) };
  }

  if (status === 200) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(bodyText);
    } catch (err) {
      return { kind: 'error', status, message: `invalid json: ${describe(err)}` };
    }

    const ready = GeneratorReadySchema.safeParse(parsed);
    if (!ready.success) {
      return {
        kind: 'error',
        status,
        message: `response did not match the ready schema: ${ready.error.issues
          .map((i) => `${i.path.join('.')} ${i.message}`)
          .join('; ')}`,
      };
    }
    const body = ready.data;

    // `fix` is required (§6): the email hands over remediation, not just
    // diagnosis. An empty subject or body is equally unusable, so a well
    // formed but empty response is a protocol error, not a finding.
    const empty: string[] = [];
    if (body.fix.trim().length === 0) empty.push('fix');
    if (body.subject.trim().length === 0) empty.push('subject');
    if (body.html.trim().length === 0) empty.push('html');
    if (body.text.trim().length === 0) empty.push('text');
    if (empty.length > 0) {
      return { kind: 'error', status, message: `ready response has empty ${empty.join(', ')}` };
    }

    // Lower number is a stronger finding. probe mails severity 1 only; a
    // severity 2 finding is recorded and then dropped as no_proof (§6).
    if (body.severity > minSeverity) {
      return { kind: 'no_proof', severity: body.severity };
    }

    return { kind: 'ready', body };
  }

  const detail = bodyText.trim().slice(0, 300);
  return {
    kind: 'error',
    status,
    message: detail.length > 0 ? `HTTP ${status}: ${detail}` : `HTTP ${status}`,
  };
}
