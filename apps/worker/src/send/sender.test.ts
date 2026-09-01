import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetEnvCache } from '@probe/config';
import { createSender, createDryRunSender, type OutboundSend } from './sender';
import { day3Send } from './day3';
import { sendEnabled } from './runtime';

const REQUIRED = {
  SUPABASE_DB_URL: 'postgres://user:pw@localhost:5432/probe',
  PROBE_HASH_PEPPER: 'test-pepper',
  PROBE_HMAC_SECRET: 'test-secret',
};

let saved: NodeJS.ProcessEnv;

beforeEach(() => {
  saved = { ...process.env };
  Object.assign(process.env, REQUIRED);
  resetEnvCache();
});

afterEach(() => {
  process.env = saved;
  resetEnvCache();
});

function withFlag(value: string | undefined): void {
  if (value === undefined) delete process.env.PROBE_SEND_ENABLED;
  else process.env.PROBE_SEND_ENABLED = value;
  resetEnvCache();
}

function message(over: Partial<OutboundSend> = {}): OutboundSend {
  return {
    fromName: 'Morten Pradsgaard',
    fromEmail: 'morten@mail.exit1.dev',
    to: 'priya@meterbase.dev',
    subject: '/v1/usage returned 502 on 3 of 20 probes this morning',
    html: '<p>finding</p>',
    text: 'finding',
    unsubscribeUrl: 'https://probe.exit1.dev/u/tok',
    mime: 'Subject: test\r\n\r\nbody',
    ...over,
  };
}

describe('createSender', () => {
  // §3.1 rule 4. Dry-run is the default and only the literal string 'true'
  // opts out of it. Anything else, including a value that looks true to a
  // human, must not reach the provider.
  it.each([undefined, 'false', 'TRUE', 'True', '1', 'yes', ''])(
    'picks the dry run sender when PROBE_SEND_ENABLED is %o',
    (value) => {
      withFlag(value as string | undefined);
      expect(sendEnabled()).toBe(false);
      expect(createSender().kind).toBe('dry-run');
    },
  );

  it('picks the Day3 sender only for the exact string "true"', () => {
    withFlag('true');
    expect(sendEnabled()).toBe(true);
    expect(createSender().kind).toBe('day3');
  });

  it('falls back to dry run when the environment cannot be loaded at all', () => {
    delete process.env.SUPABASE_DB_URL;
    delete process.env.PROBE_HASH_PEPPER;
    delete process.env.PROBE_HMAC_SECRET;
    process.env.PROBE_SEND_ENABLED = 'true';
    resetEnvCache();
    // Failing to read configuration is never a licence to send.
    expect(sendEnabled()).toBe(false);
    expect(createSender().kind).toBe('dry-run');
  });
});

describe('the dry run sender', () => {
  it('writes the preview .eml and returns a synthetic provider id', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'probe-outbox-'));
    try {
      const sender = createDryRunSender(dir);
      const res = await sender.send(message(), { sendId: 'abc-123' });

      expect(res.provider).toBe('dry-run');
      expect(res.providerEmailId).toMatch(/^dryrun-/);
      const files = await fs.readdir(dir);
      expect(files).toHaveLength(1);
      expect(files[0]).toMatch(/abc-123\.eml$/);
      expect(await fs.readFile(path.join(dir, files[0]), 'utf8')).toContain('Subject: test');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('the Day3 sender', () => {
  function day3Env(): void {
    process.env.PROBE_SEND_ENABLED = 'true';
    process.env.DAY3_API_KEY = `day3_live_${'a'.repeat(40)}`;
    process.env.DAY3_API_BASE_URL = 'https://day3.test';
    resetEnvCache();
  }

  it('sends the parts, not raw MIME, and passes the unsubscribe url as a field', async () => {
    day3Env();
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ id: 'eml_abc', status: 'queued' }), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await day3Send(
      { apiKey: 'day3_live_x', baseUrl: 'https://day3.test', fetchImpl },
      {
        from: 'Morten Pradsgaard <morten@mail.exit1.dev>',
        to: 'priya@meterbase.dev',
        subject: 'subject',
        html: '<p>finding</p>',
        text: 'finding',
        listUnsubscribe: 'https://probe.exit1.dev/u/tok',
      },
      'send-id-1',
    );

    expect(result.emailId).toBe('eml_abc');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://day3.test/api/v1/emails');

    const body = JSON.parse(String(calls[0].init.body)) as Record<string, unknown>;
    // Day3 reserves the List-Unsubscribe header names, so the dedicated field is
    // the only way probe can carry RFC 8058 one-click (§9.3).
    expect(body.list_unsubscribe).toBe('https://probe.exit1.dev/u/tok');
    expect(body.html).toBe('<p>finding</p>');
    expect(body.text).toBe('finding');
    expect(body).not.toHaveProperty('headers');

    // The send id IS the idempotency key. This is what makes a retry after an
    // ambiguous timeout a replay rather than a second email to a founder.
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers['idempotency-key']).toBe('send-id-1');
  });

  it('does not retry a refusal that can never succeed', async () => {
    let attempts = 0;
    const fetchImpl = (async () => {
      attempts += 1;
      return new Response(
        JSON.stringify({ error: { code: 'email_suppressed', message: 'suppressed' } }),
        { status: 400 },
      );
    }) as unknown as typeof fetch;

    await expect(
      day3Send(
        { apiKey: 'day3_live_x', baseUrl: 'https://day3.test', fetchImpl, sleepImpl: async () => {} },
        {
          from: 'a@mail.exit1.dev',
          to: 'b@example.com',
          subject: 's',
          html: 'h',
          text: 't',
          listUnsubscribe: 'https://probe.exit1.dev/u/tok',
        },
        'send-id-2',
      ),
    ).rejects.toThrow(/suppressed/);
    // Retrying a suppressed address is the one thing §3.1 rule 2 forbids.
    expect(attempts).toBe(1);
  });

  it('retries an ambiguous failure and replays the same idempotency key', async () => {
    let attempts = 0;
    const seenKeys = new Set<string>();
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      attempts += 1;
      seenKeys.add((init.headers as Record<string, string>)['idempotency-key']);
      if (attempts < 3) return new Response('upstream boom', { status: 503 });
      return new Response(JSON.stringify({ id: 'eml_retry', status: 'queued' }), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await day3Send(
      { apiKey: 'day3_live_x', baseUrl: 'https://day3.test', fetchImpl, sleepImpl: async () => {} },
      {
        from: 'a@mail.exit1.dev',
        to: 'b@example.com',
        subject: 's',
        html: 'h',
        text: 't',
        listUnsubscribe: 'https://probe.exit1.dev/u/tok',
      },
      'send-id-3',
    );

    expect(result.emailId).toBe('eml_retry');
    expect(attempts).toBe(3);
    expect([...seenKeys]).toEqual(['send-id-3']);
  });

  it('treats a 2xx with no email id as terminal', async () => {
    // Without an id probe has no webhook join key and no way to prove what
    // happened, so accepting it would lose the send silently.
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ status: 'queued' }), { status: 200 })) as unknown as typeof fetch;

    await expect(
      day3Send(
        { apiKey: 'day3_live_x', baseUrl: 'https://day3.test', fetchImpl, sleepImpl: async () => {} },
        {
          from: 'a@mail.exit1.dev',
          to: 'b@example.com',
          subject: 's',
          html: 'h',
          text: 't',
          listUnsubscribe: 'https://probe.exit1.dev/u/tok',
        },
        'send-id-4',
      ),
    ).rejects.toThrow(/no email id/);
  });
});
