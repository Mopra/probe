import { afterAll, describe, expect, it } from 'vitest';
import { closeSql, getSql } from './client';

/**
 * There is no database in CI, and these are the only tests that need one. They
 * run when SUPABASE_DB_URL points at a schema-applied database and are skipped
 * otherwise, so `vitest run` is always green without one.
 */
const hasDb = Boolean(process.env.SUPABASE_DB_URL);

describe.skipIf(!hasDb)('against a live database', () => {
  afterAll(async () => {
    await closeSql();
  });

  it('connects and sees the schema', async () => {
    const sql = getSql();
    const tables = await sql<{ table_name: string }[]>`
      select table_name from information_schema.tables where table_schema = 'public'
    `;
    const names = tables.map((t) => t.table_name);
    for (const t of [
      'sources', 'campaigns', 'leads', 'contacts', 'suppressions',
      'proofs', 'sends', 'events', 'app_state', '_migrations',
    ]) {
      expect(names).toContain(t);
    }
  });

  it('has the partial contact-once index (§3.2)', async () => {
    const sql = getSql();
    const idx = await sql<{ indexdef: string }[]>`
      select indexdef from pg_indexes where indexname = 'sends_email_hash_uniq'
    `;
    expect(idx).toHaveLength(1);
    expect(idx[0].indexdef).toContain('UNIQUE');
    expect(idx[0].indexdef).toMatch(/WHERE/i);
  });
});
