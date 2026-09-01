import { first, getSql, rows, withTx } from './client';
import { clampLimit } from './filters';
import type { SuppressionReason, SuppressionRow } from './types';

export async function isSuppressed(emailHash: string): Promise<boolean> {
  const sql = getSql();
  const result = await sql`select 1 as hit from suppressions where email_hash = ${emailHash}`;
  return result.length > 0;
}

/** Batch form for the sweep and resolve jobs, which check many hashes at once. */
export async function suppressedHashes(hashes: string[]): Promise<Set<string>> {
  if (hashes.length === 0) return new Set();
  const sql = getSql();
  const result = await sql`
    select email_hash from suppressions where email_hash in ${sql(hashes)}
  `;
  return new Set(rows<{ email_hash: string }>(result).map((r) => r.email_hash));
}

/**
 * §3.1 rule 2 and §9.3, in one transaction. The insert is idempotent, but the
 * scrub runs regardless of whether the insert did anything: an address can
 * arrive here twice (an unsubscribe click followed by an SES complaint) and the
 * second visit must still clear any contact row written in between.
 *
 * email_hash, method and found_at survive the scrub, so GDPR provenance for the
 * suppression itself is intact while the plaintext address is gone.
 */
export async function addSuppression(a: {
  email_hash: string;
  reason: SuppressionReason;
  detail?: string | null;
}): Promise<void> {
  await withTx(async (tx) => {
    await tx`
      insert into suppressions (email_hash, reason, detail)
      values (${a.email_hash}, ${a.reason}, ${a.detail ?? null})
      on conflict (email_hash) do nothing
    `;
    await tx`
      update contacts
         set email = null, email_norm = null
       where email_hash = ${a.email_hash}
         and (email is not null or email_norm is not null)
    `;
  });
}

export async function listSuppressions(limit = 200): Promise<SuppressionRow[]> {
  const sql = getSql();
  return rows<SuppressionRow>(await sql`
    select * from suppressions
    order by created_at desc
    limit ${clampLimit(limit, 200, 5000)}
  `);
}

/**
 * GDPR erasure by hash. Removes the sends and their events, then the contact
 * rows themselves, which is more than the §9.3 scrub: the scrub keeps
 * provenance, an erasure request does not get to.
 *
 * The suppression row stays. Deleting it would let the address be contacted
 * again, which is the opposite of what the person asked for, and it holds only
 * a peppered hash with no way back to the address.
 */
export async function eraseByHash(emailHash: string): Promise<Record<string, number>> {
  return withTx(async (tx) => {
    const events = await tx`
      delete from events
       where send_id in (select id from sends where email_hash = ${emailHash})
    `;
    const sends = await tx`delete from sends where email_hash = ${emailHash}`;
    const contacts = await tx`delete from contacts where email_hash = ${emailHash}`;
    const kept = await tx`
      select count(*)::int as n from suppressions where email_hash = ${emailHash}
    `;
    return {
      events: events.count,
      sends: sends.count,
      contacts: contacts.count,
      suppressions_kept: first<{ n: number }>(kept)?.n ?? 0,
    };
  });
}
