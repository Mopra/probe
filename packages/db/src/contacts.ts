import { first, getSql } from './client';
import type { ContactRow } from './types';

/**
 * §8.3: the contact row is written before the suppression and contacted-once
 * checks run, so a lead dropped as `contacted_other_campaign` is attributable
 * and the §3.2 cost is measurable rather than guessed.
 *
 * contacts_lead_hash_uniq is per lead, so re-running resolution for a lead is
 * idempotent.
 */
export async function insertContact(c: {
  lead_id: string;
  email: string;
  email_norm: string;
  email_hash: string;
  first_name: string | null;
  method: string;
  confidence: number;
}): Promise<ContactRow> {
  const sql = getSql();
  const result = await sql`
    insert into contacts (
      lead_id, email, email_norm, email_hash, first_name, method, confidence
    ) values (
      ${c.lead_id}::uuid, ${c.email}, ${c.email_norm}, ${c.email_hash},
      ${c.first_name}, ${c.method}, ${c.confidence}
    )
    -- email and email_norm are deliberately absent from the update below: a row
    -- scrubbed on suppression (§9.3) must stay scrubbed, so re-running
    -- resolution can never put the address back.
    on conflict (lead_id, email_hash) do update
      set first_name = coalesce(excluded.first_name, contacts.first_name),
          method     = excluded.method,
          confidence = excluded.confidence
    returning *
  `;
  const row = first<ContactRow>(result);
  if (!row) throw new Error(`insertContact returned no row for lead ${c.lead_id}`);
  return row;
}

export async function getContactForLead(leadId: string): Promise<ContactRow | null> {
  const sql = getSql();
  // Highest confidence wins when a lead somehow has more than one address.
  return first<ContactRow>(await sql`
    select * from contacts
     where lead_id = ${leadId}::uuid
     order by confidence desc, found_at desc
     limit 1
  `);
}
