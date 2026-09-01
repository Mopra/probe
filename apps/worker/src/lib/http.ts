// Shared HTTP helpers for the worker. Owned by the integration pass.
//
// Everything the worker fetches is somebody else's website: a launch
// directory, a founder's landing page, a security.txt. All of it is
// untrusted, frequently slow, and occasionally enormous. These helpers make
// the failure modes boring.

import { logger } from '@probe/config';

const log = logger('http');

/** We identify ourselves honestly. §9.2 is built on radical provenance and
 *  that does not start at the email: a founder who greps their access log
 *  after getting the email should find something that explains itself. */
export const USER_AGENT =
  'probe/0.1 (+https://exit1.dev/probe; outreach research; morten@mail.exit1.dev)';

/** Nothing we read from a stranger's site is worth more than this. A landing
 *  page that is 5 MB of JavaScript has no address in it either. */
const MAX_BYTES = 2_000_000;
const DEFAULT_TIMEOUT_MS = 15_000;

export interface FetchTextResult {
  ok: boolean;
  status: number;
  url: string;
  /** Truncated at MAX_BYTES. Empty string when the response was not text. */
  text: string;
  contentType: string | null;
  error?: string;
}

/** GET a URL as text. Never throws: a dead landing page is an expected
 *  outcome of the contact cascade, not an exception. */
export async function fetchText(
  url: string,
  opts: { timeoutMs?: number; headers?: Record<string, string>; accept?: string } = {},
): Promise<FetchTextResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        'user-agent': USER_AGENT,
        accept: opts.accept ?? 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8',
        ...opts.headers,
      },
    });

    const contentType = res.headers.get('content-type');
    let text = '';
    if (res.body) {
      text = await readCapped(res, MAX_BYTES);
    }
    return { ok: res.ok, status: res.status, url: res.url || url, text, contentType };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log.debug('fetch failed', { url, error });
    return { ok: false, status: 0, url, text: '', contentType: null, error };
  }
}

/** GET and parse JSON. Same no-throw contract as fetchText. */
export async function fetchJson<T>(
  url: string,
  opts: { timeoutMs?: number; headers?: Record<string, string> } = {},
): Promise<{ ok: boolean; status: number; data: T | null; error?: string }> {
  const res = await fetchText(url, { ...opts, accept: 'application/json' });
  if (!res.ok) return { ok: false, status: res.status, data: null, error: res.error };
  try {
    return { ok: true, status: res.status, data: JSON.parse(res.text) as T };
  } catch (err) {
    return {
      ok: false,
      status: res.status,
      data: null,
      error: err instanceof Error ? err.message : 'invalid json',
    };
  }
}

/** POST JSON. Returns the raw body so a caller that needs to validate a
 *  signature or a schema sees the exact bytes. */
export async function postJson(
  url: string,
  body: string,
  opts: { timeoutMs?: number; headers?: Record<string, string> } = {},
): Promise<{ ok: boolean; status: number; text: string; error?: string }> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      body,
      signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      headers: {
        'user-agent': USER_AGENT,
        'content-type': 'application/json',
        ...opts.headers,
      },
    });
    return { ok: res.ok, status: res.status, text: await readCapped(res, MAX_BYTES) };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      text: '',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function readCapped(res: Response, maxBytes: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    chunks.push(value);
    total += value.byteLength;
    if (total >= maxBytes) {
      await reader.cancel().catch(() => undefined);
      break;
    }
  }
  const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)), Math.min(total, maxBytes));
  return buf.toString('utf8');
}

/** Retry with exponential backoff and full jitter. Used for the generator
 *  call (§6: 3 attempts) and for directory APIs that rate limit. */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: { attempts?: number; baseMs?: number; shouldRetry?: (result: T) => boolean } = {},
): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const baseMs = opts.baseMs ?? 1_000;
  let last: T | undefined;
  for (let i = 1; i <= attempts; i++) {
    last = await fn(i);
    if (!opts.shouldRetry || !opts.shouldRetry(last)) return last;
    if (i < attempts) await sleep(Math.random() * baseMs * 2 ** (i - 1));
  }
  return last as T;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}
