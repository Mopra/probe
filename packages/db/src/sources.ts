import { getSql, rows } from './client';
import type { SourceRow } from './types';

export async function upsertSource(s: {
  id: string;
  name: string;
  kind: string;
  enabled?: boolean;
}): Promise<void> {
  const sql = getSql();
  await sql`
    insert into sources (id, name, kind, enabled)
    values (${s.id}, ${s.name}, ${s.kind}, ${s.enabled ?? true})
    on conflict (id) do update
      set name = excluded.name,
          kind = excluded.kind,
          enabled = excluded.enabled
  `;
}

export async function listSources(): Promise<SourceRow[]> {
  const sql = getSql();
  return rows<SourceRow>(await sql`select * from sources order by id`);
}

export async function markSweepOk(id: string): Promise<void> {
  const sql = getSql();
  // Clear last_error on success so /health shows a stale failure only while it
  // is still true.
  await sql`update sources set last_swept_at = now(), last_error = null where id = ${id}`;
}

export async function markSweepError(id: string, error: string): Promise<void> {
  const sql = getSql();
  // last_swept_at is deliberately not touched: a failed sweep did not sweep.
  await sql`update sources set last_error = ${error} where id = ${id}`;
}
