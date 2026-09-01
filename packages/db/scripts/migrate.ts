/**
 * Applies every migrations/*.sql not already recorded in _migrations, in
 * filename order, each in its own transaction.
 *
 * Run with tsx:
 *   pnpm --filter @probe/db migrate
 *   pnpm --filter @probe/db migrate -- --dry
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadEnv, logger } from '@probe/config';
import postgres from 'postgres';

const log = logger('migrate');

const MIGRATIONS_DIR = path.resolve(__dirname, '..', 'migrations');

interface Migration {
  id: string;
  file: string;
  sql: string;
}

function readMigrations(): Migration[] {
  if (!fs.existsSync(MIGRATIONS_DIR)) {
    throw new Error(`no migrations directory at ${MIGRATIONS_DIR}`);
  }
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    // Filename order is the migration order, which is why they are numbered.
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((f) => ({
      id: f.replace(/\.sql$/, ''),
      file: path.join(MIGRATIONS_DIR, f),
      sql: fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8'),
    }));
}

async function main(): Promise<void> {
  const dry = process.argv.includes('--dry');
  const url = loadEnv().SUPABASE_DB_URL;

  const all = readMigrations();
  if (all.length === 0) {
    log.warn('no migrations found', { dir: MIGRATIONS_DIR });
    return;
  }

  // A dedicated connection rather than getSql(): migrations run DDL, want
  // max: 1, and must not leave a pool behind when the script exits. Prepared
  // statements are off because the Supabase transaction pooler cannot do them
  // and a migration is the worst place to discover that.
  const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} });

  try {
    // Bootstrap: the ledger has to exist before it can be read, and 0001 also
    // creates it, so this must be idempotent and outside the loop.
    await sql`
      create table if not exists _migrations (
        id         text primary key,
        applied_at timestamptz not null default now()
      )
    `;

    const applied = new Set(
      (await sql<{ id: string }[]>`select id from _migrations`).map((r) => r.id),
    );
    const pending = all.filter((m) => !applied.has(m.id));

    if (pending.length === 0) {
      log.info('up to date', { applied: applied.size });
      return;
    }

    if (dry) {
      log.info('pending migrations', {
        count: pending.length,
        ids: pending.map((m) => m.id),
      });
      return;
    }

    for (const m of pending) {
      const started = Date.now();
      // One transaction per migration: a partial schema change is worse than a
      // failed one, and the ledger row lands or does not land with it.
      await sql.begin(async (tx) => {
        await tx.unsafe(m.sql);
        await tx`insert into _migrations (id) values (${m.id})`;
      });
      log.info('applied', { id: m.id, ms: Date.now() - started });
    }

    log.info('done', { applied: pending.length });
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err: unknown) => {
  log.error('migration failed', { err });
  process.exitCode = 1;
});
