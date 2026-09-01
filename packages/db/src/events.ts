import { getSql, jsonParam, rows } from './client';
import type { EventRow } from './types';

export async function insertEvent(e: {
  send_id: string | null;
  type: string;
  detail?: Record<string, unknown>;
  occurred_at?: Date;
}): Promise<void> {
  const sql = getSql();
  // occurred_at comes from the SES notification when there is one, so the
  // rolling rate windows (§5.5) measure when things happened rather than when
  // the webhook was processed.
  await sql`
    insert into events (send_id, type, detail, occurred_at)
    values (
      ${e.send_id}::uuid,
      ${e.type},
      ${sql.json(jsonParam(e.detail ?? {}))},
      ${e.occurred_at ?? new Date()}
    )
  `;
}

export async function listEventsForSend(sendId: string): Promise<EventRow[]> {
  const sql = getSql();
  return rows<EventRow>(await sql`
    select * from events where send_id = ${sendId}::uuid order by occurred_at, id
  `);
}
