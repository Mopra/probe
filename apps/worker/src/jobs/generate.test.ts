import { describe, expect, it } from 'vitest';
import type { GeneratorOutcome, GeneratorReady } from '@probe/core';
import type { ProofRow } from '@probe/db';
import {
  applyOutcome,
  buildGeneratorRequest,
  budgetExhausted,
  errorBackoffMs,
  mapLimit,
  type GenerateDeps,
} from './generate';
import { buildFixtures } from '../harness/fixtures';

// ---------------------------------------------------------------------------
// the bounded concurrency helper
// ---------------------------------------------------------------------------

describe('mapLimit', () => {
  it('never exceeds the limit and preserves order', async () => {
    let inFlight = 0;
    let peak = 0;
    const items = Array.from({ length: 12 }, (_, i) => i);

    const out = await mapLimit(items, 3, async (n) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5 + (n % 3) * 3));
      inFlight -= 1;
      return n * 2;
    });

    // §8.4: exit1's probe infrastructure must not be hammered by exit1's own
    // outreach tool.
    expect(peak).toBe(3);
    expect(out).toEqual(items.map((n) => n * 2));
  });

  it('treats a limit below one as one', async () => {
    let peak = 0;
    let inFlight = 0;
    await mapLimit([1, 2, 3], 0, async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 2));
      inFlight -= 1;
    });
    expect(peak).toBe(1);
  });

  it('drains every worker before surfacing the first error', async () => {
    const finished: number[] = [];
    await expect(
      mapLimit([1, 2, 3, 4], 2, async (n) => {
        await new Promise((r) => setTimeout(r, 2));
        if (n === 2) throw new Error('boom');
        finished.push(n);
      }),
    ).rejects.toThrow('boom');
    expect(finished.sort()).toEqual([1, 3, 4]);
  });

  it('handles an empty list', async () => {
    expect(await mapLimit([], 3, async () => 1)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// outcome to database transition
// ---------------------------------------------------------------------------

interface Recorded {
  calls: string[];
  patches: Array<Record<string, unknown>>;
  deps: GenerateDeps;
}

function recorder(): Recorded {
  const calls: string[] = [];
  const patches: Array<Record<string, unknown>> = [];
  const deps: GenerateDeps = {
    async markProofReady(id, p) {
      calls.push('markProofReady');
      patches.push({ id, ...p });
    },
    async markProofNoProof(id, detail) {
      calls.push('markProofNoProof');
      patches.push({ id, detail });
    },
    async markProofFailed(id, error) {
      calls.push('markProofFailed');
      patches.push({ id, error });
    },
    async markProofAttempt(id, patch) {
      calls.push('markProofAttempt');
      patches.push({ id, ...patch });
    },
    async setLeadStatus(id, status) {
      calls.push(`setLeadStatus:${status}`);
      patches.push({ id, status });
    },
    async dropLead(id, reason) {
      calls.push(`dropLead:${reason}`);
      patches.push({ id, reason });
    },
  };
  return { calls, patches, deps };
}

const BUDGET_MS = 2 * 60 * 60 * 1000;
const NOW = new Date('2026-09-01T08:00:00Z');

function fixture(id: string) {
  const f = buildFixtures().find((x) => x.id === id);
  if (!f) throw new Error(`no fixture ${id}`);
  return f;
}

function readyBody(fixtureId: string): GeneratorReady {
  const f = fixture(fixtureId);
  return {
    status: 'ready',
    severity: 1,
    subject: f.proof.subject as string,
    html: f.proof.html as string,
    text: f.proof.text_body as string,
    fix: f.proof.fix as string,
    evidence_url: f.proof.evidence_url as string,
    meta: { probes: 20, failures: 3 },
  };
}

function context(outcome: GeneratorOutcome, proofOver: Partial<ProofRow> = {}, deps?: GenerateDeps) {
  const f = fixture('severity-1-clean');
  return {
    outcome,
    proof: {
      ...f.proof,
      html: null,
      text_body: null,
      subject: null,
      status: 'pending' as const,
      attempts: 0,
      polls: 0,
      first_requested_at: null,
      ...proofOver,
    },
    lead: f.lead,
    campaign: f.campaign,
    contact: f.contact,
    now: NOW,
    budgetMs: BUDGET_MS,
    maxAttempts: 3,
    baseUrl: 'https://probe.exit1.dev',
    postalAddress: 'Pradsgaard Labs, Testvej 1, 2100 Copenhagen, Denmark',
    deps,
  };
}

describe('applyOutcome', () => {
  it('ready and lint clean marks the proof ready and the lead ready', async () => {
    const rec = recorder();
    const effect = await applyOutcome(
      context({ kind: 'ready', body: readyBody('severity-1-clean') }, {}, rec.deps),
    );
    expect(effect).toEqual({ effect: 'ready' });
    expect(rec.calls).toEqual(['markProofReady', 'setLeadStatus:ready']);
  });

  it('ready but failing the lint fails the proof and drops the lead', async () => {
    // §9.2.8. Running the lint at generation means a generator that drifted
    // salesy is visible at 07:30, not when Morten opens the queue.
    const rec = recorder();
    const effect = await applyOutcome(
      context({ kind: 'ready', body: readyBody('trips-call-to-action') }, {}, rec.deps),
    );
    expect(effect.effect).toBe('lint_failed');
    expect(rec.calls).toEqual(['markProofFailed', 'dropLead:generator_failed']);
  });

  it('no_proof records it and drops the lead, without an error', async () => {
    const rec = recorder();
    const effect = await applyOutcome(context({ kind: 'no_proof' }, {}, rec.deps));
    expect(effect).toEqual({ effect: 'no_proof' });
    expect(rec.calls).toEqual(['markProofNoProof', 'dropLead:no_proof']);
  });

  it('the first pending response sets first_requested_at and polls 1', async () => {
    const rec = recorder();
    const effect = await applyOutcome(
      context({ kind: 'pending', retryAfterMs: 300_000 }, { polls: 0 }, rec.deps),
    );
    expect(effect).toMatchObject({ effect: 'pending', polls: 1 });
    expect(rec.calls).toEqual(['markProofAttempt']);
    expect(rec.patches[0]).toMatchObject({ polls: 1, first_requested_at: NOW });
    expect((rec.patches[0].next_poll_at as Date).getTime()).toBe(NOW.getTime() + 300_000);
  });

  it('a later pending response never resets first_requested_at', async () => {
    // Resetting it on every poll would turn a two hour budget into never.
    const first = new Date(NOW.getTime() - 30 * 60_000);
    const rec = recorder();
    await applyOutcome(
      context(
        { kind: 'pending', retryAfterMs: 600_000 },
        { polls: 4, first_requested_at: first },
        rec.deps,
      ),
    );
    expect(rec.patches[0]).toMatchObject({ polls: 5 });
    expect(rec.patches[0].first_requested_at).toBeUndefined();
  });

  it('pending past the elapsed time budget fails the proof and drops the lead', async () => {
    const first = new Date(NOW.getTime() - BUDGET_MS - 60_000);
    const rec = recorder();
    const effect = await applyOutcome(
      context({ kind: 'pending', retryAfterMs: 300_000 }, { first_requested_at: first }, rec.deps),
    );
    expect(effect.effect).toBe('budget_exhausted');
    expect(rec.calls).toEqual(['markProofFailed', 'dropLead:generator_failed']);
  });

  it('pending at 119 minutes is still inside the budget', async () => {
    // §6 sizes the budget for the contract, which allows 202 and polling, not
    // for exit1's generator, which answers synchronously in seconds.
    const first = new Date(NOW.getTime() - 119 * 60_000);
    const rec = recorder();
    const effect = await applyOutcome(
      context({ kind: 'pending', retryAfterMs: 300_000 }, { first_requested_at: first }, rec.deps),
    );
    expect(effect.effect).toBe('pending');
  });

  it('an error below the attempt limit backs off and retries', async () => {
    const rec = recorder();
    const effect = await applyOutcome(
      context({ kind: 'error', status: 503, message: 'upstream busy' }, { attempts: 1 }, rec.deps),
    );
    expect(effect).toMatchObject({ effect: 'retry', attempts: 2 });
    expect(rec.calls).toEqual(['markProofAttempt']);
    expect((rec.patches[0].next_poll_at as Date).getTime()).toBeGreaterThan(NOW.getTime());
  });

  it('the third failed attempt fails the proof and drops the lead', async () => {
    const rec = recorder();
    const effect = await applyOutcome(
      context({ kind: 'error', message: 'timeout' }, { attempts: 2 }, rec.deps),
    );
    expect(effect).toMatchObject({ effect: 'failed', attempts: 3 });
    expect(rec.calls).toEqual(['markProofFailed', 'dropLead:generator_failed']);
  });
});

describe('budgetExhausted', () => {
  it('is false before the first request has been made', () => {
    expect(budgetExhausted(null, NOW, BUDGET_MS)).toBe(false);
  });
  it('is true only strictly past the budget', () => {
    expect(budgetExhausted(new Date(NOW.getTime() - BUDGET_MS), NOW, BUDGET_MS)).toBe(false);
    expect(budgetExhausted(new Date(NOW.getTime() - BUDGET_MS - 1), NOW, BUDGET_MS)).toBe(true);
  });
});

describe('errorBackoffMs', () => {
  it('grows and then stops growing', () => {
    expect(errorBackoffMs(1)).toBe(60_000);
    expect(errorBackoffMs(2)).toBe(120_000);
    expect(errorBackoffMs(9)).toBe(15 * 60_000);
  });
});

describe('buildGeneratorRequest', () => {
  it('never carries the email address', () => {
    // §6. The generator has no need for it, and keeping it off the wire means
    // a generator bug cannot leak contact data.
    const f = fixture('severity-1-clean');
    const request = buildGeneratorRequest(f.lead, f.contact);
    const serialized = JSON.stringify(request);
    expect(serialized).not.toContain(f.contact.email as string);
    expect(serialized).not.toContain(f.contact.email_hash);
    expect(request.recipient).toEqual({ first_name: 'Priya' });
    expect(Object.keys(request.recipient)).toEqual(['first_name']);
  });
});
