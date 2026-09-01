import { first, getSql, jsonParam, rows } from './client';
import { clampLimit } from './filters';
import type { ProofRow } from './types';

/**
 * proofs_lead_uniq means one proof per lead, ever. Re-running the generate job
 * for a lead therefore returns the existing row rather than starting a second
 * elapsed-time budget (§6).
 */
export async function createProof(p: {
  lead_id: string;
  campaign_id: string;
}): Promise<ProofRow> {
  const sql = getSql();
  const result = await sql`
    insert into proofs (lead_id, campaign_id)
    values (${p.lead_id}::uuid, ${p.campaign_id}::uuid)
    on conflict (lead_id) do update set campaign_id = excluded.campaign_id
    returning *
  `;
  const row = first<ProofRow>(result);
  if (!row) throw new Error(`createProof returned no row for lead ${p.lead_id}`);
  return row;
}

export async function getProof(id: string): Promise<ProofRow | null> {
  const sql = getSql();
  return first<ProofRow>(await sql`select * from proofs where id = ${id}::uuid`);
}

export async function getProofForLead(leadId: string): Promise<ProofRow | null> {
  const sql = getSql();
  return first<ProofRow>(await sql`select * from proofs where lead_id = ${leadId}::uuid`);
}

/**
 * Pending proofs whose next_poll_at has come round, plus those that have never
 * been polled. Ordered oldest first so a proof close to the two hour budget is
 * revisited before a fresh one.
 */
export async function duePendingProofs(now: Date, limit = 50): Promise<ProofRow[]> {
  const sql = getSql();
  return rows<ProofRow>(await sql`
    select * from proofs
     where status = 'pending'
       and (next_poll_at is null or next_poll_at <= ${now})
     order by coalesce(first_requested_at, created_at)
     limit ${clampLimit(limit, 50, 500)}
  `);
}

export interface ProofAttemptPatch {
  attempts?: number;
  polls?: number;
  next_poll_at?: Date | null;
  first_requested_at?: Date | null;
  error?: string | null;
}

/**
 * Partial update. Keys absent from the patch are left alone; a key present with
 * an explicit null is written as null, which is how an error is cleared after a
 * successful retry.
 */
export async function markProofAttempt(id: string, patch: ProofAttemptPatch): Promise<void> {
  const entries = Object.entries(patch).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return;

  const sql = getSql();
  const patchObj = Object.fromEntries(entries) as Record<string, unknown>;
  await sql`
    update proofs set ${sql(patchObj, ...Object.keys(patchObj))} where id = ${id}::uuid
  `;
}

export async function markProofReady(
  id: string,
  p: {
    subject: string;
    html: string;
    text_body: string;
    fix: string;
    severity: number;
    evidence_url: string;
    meta: Record<string, unknown>;
  },
): Promise<void> {
  const sql = getSql();
  await sql`
    update proofs
       set subject      = ${p.subject},
           html         = ${p.html},
           text_body    = ${p.text_body},
           fix          = ${p.fix},
           severity     = ${p.severity},
           evidence_url = ${p.evidence_url},
           meta         = ${sql.json(jsonParam(p.meta))},
           status       = 'ready',
           error        = null,
           ready_at     = now()
     where id = ${id}::uuid
  `;
}

/**
 * §6: 204, or a finding below the severity bar. Not an error, and expected to
 * be the majority outcome. The severity that failed the bar is kept on the row
 * by the caller so a drift toward pedantic findings is visible.
 */
export async function markProofNoProof(id: string, detail?: string): Promise<void> {
  const sql = getSql();
  await sql`
    update proofs
       set status = 'no_proof', error = ${detail ?? null}, ready_at = now()
     where id = ${id}::uuid
  `;
}

export async function markProofFailed(id: string, error: string): Promise<void> {
  const sql = getSql();
  await sql`update proofs set status = 'failed', error = ${error} where id = ${id}::uuid`;
}
