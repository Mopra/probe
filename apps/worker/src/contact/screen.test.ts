import { beforeEach, describe, expect, it, vi } from 'vitest';

// The verdict write is the only database call the screen makes. Mocked so the
// tests can see whether it happened, and so nothing here needs a database.
const { setContactScreen } = vi.hoisted(() => ({
  setContactScreen: vi.fn(async (_id: string, _s: { verdict: string; reason: string }) => undefined),
}));
vi.mock('@probe/db', () => ({ setContactScreen }));

import { fixtureContact, fixtureLead } from '../harness/fixtures';
import { parseScreenAnswer, passes, screenContact } from './screen';

type PostResult = { ok: boolean; status: number; text: string; error?: string };

/** A stand-in for postJson that answers like OpenRouter would. */
function answering(content: string, status = 200): () => Promise<PostResult> {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    text: JSON.stringify({ choices: [{ message: { content } }] }),
  });
}

const opts = { apiKey: 'sk-or-test', model: 'openai/gpt-5.4-nano' };

beforeEach(() => {
  setContactScreen.mockClear();
});

describe('parseScreenAnswer', () => {
  it('reads the requested shape, with or without a code fence', () => {
    expect(parseScreenAnswer('{"verdict":"person","confidence":0.9,"reason":"a name"}')).toEqual({
      verdict: 'person',
      confidence: 0.9,
      reason: 'a name',
    });
    expect(
      parseScreenAnswer('```json\n{"verdict":"junk","confidence":0.8,"reason":"token"}\n```')?.verdict,
    ).toBe('junk');
  });

  it('refuses anything it would have to guess at', () => {
    expect(parseScreenAnswer('person')).toBeNull();
    expect(parseScreenAnswer('{"verdict":"maybe","confidence":0.5,"reason":"x"}')).toBeNull();
    expect(parseScreenAnswer('{"verdict":"person","confidence":7,"reason":"x"}')).toBeNull();
    expect(parseScreenAnswer('{"verdict":"person"')).toBeNull();
  });
});

describe('passes', () => {
  it('mails a person and nothing else', () => {
    expect(passes('person')).toBe(true);
    expect(passes('shared')).toBe(false);
    expect(passes('junk')).toBe(false);
  });
});

describe('screenContact', () => {
  it('rejects on the rules without asking the model, and records why', async () => {
    const post = vi.fn(answering('{"verdict":"person","confidence":1,"reason":"x"}'));
    const contact = fixtureContact({ email: '562ae1d6@ssh.ephemerals.dev', email_norm: '562ae1d6@ssh.ephemerals.dev' });
    const out = await screenContact(contact, fixtureLead(), { ...opts, post });
    expect(out.decision).toBe('reject');
    expect(post).not.toHaveBeenCalled();
    expect(setContactScreen).toHaveBeenCalledWith(contact.id, {
      verdict: 'junk',
      reason: expect.stringMatching(/^rules: /),
    });
  });

  it('passes a person verdict and caches it', async () => {
    const post = vi.fn(answering('{"verdict":"person","confidence":0.92,"reason":"founder name"}'));
    const out = await screenContact(fixtureContact(), fixtureLead(), { ...opts, post });
    expect(out).toMatchObject({ decision: 'pass', stage: 'llm' });
    expect(setContactScreen).toHaveBeenCalledWith(fixtureContact().id, {
      verdict: 'person',
      reason: 'llm 0.92: founder name',
    });
  });

  it('rejects shared and junk verdicts', async () => {
    for (const verdict of ['shared', 'junk']) {
      const post = vi.fn(answering(`{"verdict":"${verdict}","confidence":0.95,"reason":"r"}`));
      const out = await screenContact(fixtureContact(), fixtureLead(), { ...opts, post });
      expect(out).toMatchObject({ decision: 'reject', verdict, stage: 'llm' });
    }
  });

  it('defers on an API error or a malformed answer, and writes nothing', async () => {
    const down = await screenContact(fixtureContact(), fixtureLead(), {
      ...opts,
      post: answering('', 503),
    });
    const garbled = await screenContact(fixtureContact(), fixtureLead(), {
      ...opts,
      post: answering('I think this is probably a person.'),
    });
    expect(down.decision).toBe('deferred');
    expect(garbled.decision).toBe('deferred');
    expect(setContactScreen).not.toHaveBeenCalled();
  });

  it('defers without a key rather than deciding', async () => {
    const out = await screenContact(fixtureContact(), fixtureLead(), { ...opts, apiKey: null });
    expect(out.decision).toBe('deferred');
  });

  it('reads a cached verdict instead of asking again', async () => {
    const post = vi.fn(answering('{"verdict":"junk","confidence":1,"reason":"x"}'));
    const contact = fixtureContact({ screen_verdict: 'person', screen_reason: 'llm 0.90: name' });
    const out = await screenContact(contact, fixtureLead(), { ...opts, post });
    expect(out).toMatchObject({ decision: 'pass', stage: 'cache' });
    expect(post).not.toHaveBeenCalled();
  });

  it('writes nothing on a dry run', async () => {
    const post = vi.fn(answering('{"verdict":"person","confidence":0.9,"reason":"x"}'));
    await screenContact(fixtureContact(), fixtureLead(), { ...opts, post, dryRun: true });
    const junk = fixtureContact({ email: 'partners@marketsync.ai', email_norm: 'partners@marketsync.ai' });
    await screenContact(junk, fixtureLead(), { ...opts, post, dryRun: true });
    expect(setContactScreen).not.toHaveBeenCalled();
  });
});
