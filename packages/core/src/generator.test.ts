import { describe, expect, it } from 'vitest';
import {
  GeneratorReadySchema,
  GeneratorRequestSchema,
  RETRY_AFTER_MAX_MS,
  RETRY_AFTER_MIN_MS,
  callGenerator,
} from './generator';
import type { GeneratorOutcome, GeneratorRequest } from './generator';
import { verifyGeneratorSignature } from './hmac';

const URL_UNDER_TEST = 'https://exit1.dev/api/probe/generate';
const SECRET = 'probe-hmac-secret';

const REQUEST: GeneratorRequest = {
  lead_id: '01JABCDEF',
  product: {
    name: 'Meterbase',
    url: 'https://meterbase.dev',
    description: 'Usage-based billing for API companies',
    source: 'show_hn',
    launched_at: '2026-09-01T06:00:00Z',
    tags: ['api', 'billing'],
  },
  recipient: { first_name: 'Priya' },
};

const READY_BODY = {
  status: 'ready',
  severity: 1,
  subject: '/v1/usage returned 502 on 3 of 20 probes this morning',
  html: '<html><body>Your /v1/usage endpoint</body></html>',
  text: 'Your /v1/usage endpoint',
  fix: 'The 502s cluster on requests without an Accept header.',
  evidence_url: 'https://exit1.dev/probe/01JABCDEF',
  meta: { probes: 20, failures: 3 },
};

interface Captured {
  url: string;
  init: RequestInit;
}

function fakeFetch(
  respond: (captured: Captured) => Response | Promise<Response>,
  log?: Captured[],
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const captured: Captured = { url: String(input), init: init ?? {} };
    log?.push(captured);
    return respond(captured);
  }) as unknown as typeof fetch;
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function call(
  fetchImpl: typeof fetch,
  overrides: Partial<Parameters<typeof callGenerator>[0]> = {},
): Promise<GeneratorOutcome> {
  return callGenerator({
    url: URL_UNDER_TEST,
    secret: SECRET,
    request: REQUEST,
    timeoutMs: 5000,
    minSeverity: 1,
    fetchImpl,
    ...overrides,
  });
}

describe('schemas', () => {
  it('accepts the 6 request example', () => {
    expect(GeneratorRequestSchema.safeParse(REQUEST).success).toBe(true);
  });

  it('accepts the 6 ready example and rejects a missing fix', () => {
    expect(GeneratorReadySchema.safeParse(READY_BODY).success).toBe(true);
    const { fix, ...withoutFix } = READY_BODY;
    expect(fix.length).toBeGreaterThan(0);
    expect(GeneratorReadySchema.safeParse(withoutFix).success).toBe(false);
  });
});

describe('callGenerator: the signed request', () => {
  it('POSTs json with the three probe headers', async () => {
    const log: Captured[] = [];
    await call(fakeFetch(() => json(READY_BODY, 200), log));
    expect(log).toHaveLength(1);
    const { url, init } = log[0] as Captured;
    expect(url).toBe(URL_UNDER_TEST);
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['X-Probe-Timestamp']).toMatch(/^\d{10}$/);
    expect(headers['X-Probe-Signature']).toMatch(/^sha256=[0-9a-f]{64}$/);
  });

  it('signs the exact bytes it sends', async () => {
    const log: Captured[] = [];
    await call(fakeFetch(() => json(READY_BODY, 200), log));
    const { init } = log[0] as Captured;
    const headers = init.headers as Record<string, string>;
    const rawBody = init.body as string;

    expect(JSON.parse(rawBody)).toEqual(REQUEST);
    expect(
      verifyGeneratorSignature({
        secret: SECRET,
        timestamp: headers['X-Probe-Timestamp'] as string,
        rawBody,
        signature: headers['X-Probe-Signature'] as string,
      }),
    ).toBe(true);
  });
});

describe('callGenerator: 200', () => {
  it('returns ready for a severity 1 finding', async () => {
    const outcome = await call(fakeFetch(() => json(READY_BODY, 200)));
    expect(outcome.kind).toBe('ready');
    if (outcome.kind === 'ready') {
      expect(outcome.body.subject).toBe(READY_BODY.subject);
      expect(outcome.body.fix).toBe(READY_BODY.fix);
      expect(outcome.body.meta).toEqual({ probes: 20, failures: 3 });
    }
  });

  it('drops a severity 2 finding as no_proof, not as an error', async () => {
    // 6: a weak finding is a pretext, and a pretext is worse than no email.
    const outcome = await call(fakeFetch(() => json({ ...READY_BODY, severity: 2 }, 200)));
    expect(outcome.kind).toBe('no_proof');
    if (outcome.kind === 'no_proof') expect(outcome.severity).toBe(2);
  });

  it('still mails a severity 2 finding when the bar is lowered', async () => {
    const outcome = await call(fakeFetch(() => json({ ...READY_BODY, severity: 2 }, 200)), {
      minSeverity: 2,
    });
    expect(outcome.kind).toBe('ready');
  });

  it('treats a schema violation as an error, never as ready', async () => {
    const outcome = await call(fakeFetch(() => json({ status: 'ready', severity: 1 }, 200)));
    expect(outcome.kind).toBe('error');
    if (outcome.kind === 'error') expect(outcome.status).toBe(200);
  });

  it('treats an empty fix, subject, html or text as an error', async () => {
    for (const field of ['fix', 'subject', 'html', 'text'] as const) {
      const outcome = await call(fakeFetch(() => json({ ...READY_BODY, [field]: '   ' }, 200)));
      expect(outcome.kind).toBe('error');
      if (outcome.kind === 'error') expect(outcome.message).toContain(field);
    }
  });

  it('treats invalid json as an error', async () => {
    const outcome = await call(
      fakeFetch(() => new Response('not json at all', { status: 200 })),
    );
    expect(outcome.kind).toBe('error');
  });
});

describe('callGenerator: 202', () => {
  it('honours retry_after in seconds', async () => {
    const outcome = await call(fakeFetch(() => json({ status: 'pending', retry_after: 300 }, 202)));
    expect(outcome).toEqual({ kind: 'pending', retryAfterMs: 300_000 });
  });

  it('clamps a too small and a too large retry_after', async () => {
    const low = await call(fakeFetch(() => json({ status: 'pending', retry_after: 5 }, 202)));
    const high = await call(fakeFetch(() => json({ status: 'pending', retry_after: 99_999 }, 202)));
    expect(low).toEqual({ kind: 'pending', retryAfterMs: RETRY_AFTER_MIN_MS });
    expect(high).toEqual({ kind: 'pending', retryAfterMs: RETRY_AFTER_MAX_MS });
  });

  it('defaults to 300s when retry_after is absent or unusable', async () => {
    const absent = await call(fakeFetch(() => json({ status: 'pending' }, 202)));
    const empty = await call(fakeFetch(() => new Response('', { status: 202 })));
    const junk = await call(fakeFetch(() => new Response('{oops', { status: 202 })));
    expect(absent).toEqual({ kind: 'pending', retryAfterMs: 300_000 });
    expect(empty).toEqual({ kind: 'pending', retryAfterMs: 300_000 });
    expect(junk).toEqual({ kind: 'pending', retryAfterMs: 300_000 });
  });
});

describe('callGenerator: 204 and failures', () => {
  it('returns no_proof for 204', async () => {
    const outcome = await call(fakeFetch(() => new Response(null, { status: 204 })));
    expect(outcome).toEqual({ kind: 'no_proof' });
  });

  it('returns an error carrying the status for 4xx and 5xx', async () => {
    for (const status of [400, 401, 404, 429, 500, 503]) {
      const outcome = await call(fakeFetch(() => new Response('nope', { status })));
      expect(outcome.kind).toBe('error');
      if (outcome.kind === 'error') expect(outcome.status).toBe(status);
    }
  });

  it('returns an error rather than throwing on a transport failure', async () => {
    const outcome = await call(
      fakeFetch(() => {
        throw new Error('ECONNREFUSED');
      }),
    );
    expect(outcome.kind).toBe('error');
    if (outcome.kind === 'error') {
      expect(outcome.message).toContain('ECONNREFUSED');
      expect(outcome.status).toBeUndefined();
    }
  });

  it('honours timeoutMs and reports the abort as an error', async () => {
    const hanging = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) return;
        signal.addEventListener('abort', () => reject(signal.reason));
      })) as unknown as typeof fetch;

    const outcome = await call(hanging, { timeoutMs: 25 });
    expect(outcome.kind).toBe('error');
    if (outcome.kind === 'error') expect(outcome.message.length).toBeGreaterThan(0);
  });
});
