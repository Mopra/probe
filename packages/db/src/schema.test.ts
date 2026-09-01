import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const PKG = path.resolve(__dirname, '..');
const MIGRATIONS = path.join(PKG, 'migrations');
const schema = fs.readFileSync(path.join(PKG, 'schema.sql'), 'utf8');
const init = fs.readFileSync(path.join(MIGRATIONS, '0001_init.sql'), 'utf8');

/** Strips the leading comment block so two files can be compared. */
function body(sql: string): string {
  return sql.slice(sql.indexOf('create extension')).trim();
}

function migrationFiles(): string[] {
  return fs
    .readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

function laterMigrations(): Array<{ file: string; sql: string }> {
  return migrationFiles()
    .filter((f) => !f.startsWith('0001'))
    .map((file) => ({ file, sql: fs.readFileSync(path.join(MIGRATIONS, file), 'utf8') }));
}

/**
 * schema.sql is the whole schema as of now; the migrations are how a database
 * that already exists gets there. Applying schema.sql to an empty database and
 * applying every migration in order have to land in the same place.
 *
 * That is asserted structurally rather than by string equality. 0001 is the
 * base and was byte-identical to schema.sql when it was the only migration, but
 * a later migration is written as ALTERs and DROP/CREATEs against a live table,
 * and there is no textual form of that which equals the CREATE TABLE it
 * converges on. So instead: 0001 stays frozen, and everything a later migration
 * adds must also be visible in schema.sql.
 */
describe('schema.sql', () => {
  it('keeps 0001 frozen as the base', () => {
    // 0001 has already run on the live database, so it can never be edited
    // again: a change belongs in a new numbered migration. These assertions
    // exist to make an edit to it fail loudly rather than silently diverge.
    const base = body(init);
    expect(base).toContain('create table if not exists sends');
    expect(base).toContain('create table if not exists leads');
    expect(base).toContain('create table if not exists suppressions');
    // The original narrow form of the contact-once index. 0002 widens it; if
    // someone "fixes" 0001 to match schema.sql, a database that already ran
    // 0001 would never get the widening.
    expect(base).toMatch(/sends_email_hash_uniq on sends \(email_hash\)\s*where status in \('queued','sent'\)/);
  });

  it('carries every column and index the later migrations add', () => {
    for (const { file, sql } of laterMigrations()) {
      for (const [, table, column] of sql.matchAll(
        /alter table (\w+) add column if not exists (\w+)/g,
      )) {
        expect(
          new RegExp(`create table if not exists ${table}[\\s\\S]*?\\n\\s+${column}\\b`).test(schema),
          `${file} adds ${table}.${column}; schema.sql must declare it too`,
        ).toBe(true);
      }
      for (const [, name] of sql.matchAll(/create (?:unique )?index if not exists (\w+)/g)) {
        expect(schema, `${file} creates ${name}; schema.sql must create it too`).toContain(name);
      }
    }
  });

  it('carries the two indexes that carry the safety (§7)', () => {
    // §3.2: contact-once is a constraint violation, not a race condition. The
    // partial where clause is what lets a failed or cancelled send release the
    // slot, and 'sending' is in it because the atomic claim window must not
    // free the slot to a second lead mid-dispatch (§8.6).
    expect(schema).toMatch(
      /create unique index if not exists sends_email_hash_uniq on sends \(email_hash\)\s*where status in \('queued','sending','sent'\)/,
    );
    // Same product on three directories is one lead.
    expect(schema).toMatch(/create unique index if not exists leads_domain_uniq on leads \(domain\)/);
  });

  it('keeps the load-bearing index comments', () => {
    expect(schema).toContain('This is the policy lever');
    expect(schema).toContain('Same product on three directories is one lead');
    expect(schema).toContain('The one-email guarantee lives on sends, not here');
  });

  it('has the additive columns the app needs', () => {
    expect(schema).toMatch(/exclude_tags\s+text\[\] not null default '\{\}'/);
    expect(schema).toMatch(/exclude_keywords\s+text\[\] not null default '\{\}'/);
    expect(schema).toContain('jurisdiction_detail text');
    expect(schema).toMatch(/severity\s+int/);
    expect(schema).toMatch(/fix\s+text/);
    expect(schema).toContain('first_requested_at timestamptz');
    expect(schema).toContain('next_poll_at       timestamptz');
  });

  it('records both provider ids on a send (§5.1)', () => {
    // probe does not talk to SES; Day3 does. So a send has Day3's email id,
    // known at dispatch, and the SES message id, which arrives on the first
    // event and is null until then.
    expect(schema).toMatch(/create table if not exists sends[\s\S]*?provider_email_id text/);
    expect(schema).toMatch(/create table if not exists sends[\s\S]*?ses_message_id text/);
    expect(schema).toContain('sends_provider_email_id_uniq');
  });

  it('does NOT store rendered copy on sends: the proof plus footer is the source of truth', () => {
    expect(schema).not.toMatch(/create table if not exists sends[\s\S]*?\n\s+html\s+text/);
    expect(schema).not.toMatch(/create table if not exists sends[\s\S]*?\n\s+text_body\s+text/);
  });

  it('creates _migrations and app_state', () => {
    expect(schema).toContain('create table if not exists _migrations');
    expect(schema).toContain('create table if not exists app_state');
  });

  it('is safe to re-run', () => {
    const creates = schema.match(/^create (table|index|unique index)\b.*/gm) ?? [];
    for (const line of creates) {
      expect(line).toContain('if not exists');
    }
    // Postgres has no `create type if not exists`, hence the do-block guards.
    expect(schema).toMatch(/if not exists \(select 1 from pg_type where typname = 'lead_status'\)/);
    expect(schema).toMatch(
      /if not exists \(select 1 from pg_type where typname = 'suppression_reason'\)/,
    );
  });

  it('has migrations that are safe to re-run too', () => {
    // A migration runs once per database by the ledger, but `pnpm migrate` gets
    // re-run by hand often enough (and against databases at different points)
    // that every statement is written to be idempotent anyway.
    for (const file of migrationFiles()) {
      const sql = fs.readFileSync(path.join(MIGRATIONS, file), 'utf8');
      for (const line of sql.match(/^(create|alter|drop) .*/gim) ?? []) {
        if (/^create extension/i.test(line)) continue;
        expect(line, `${file}: ${line}`).toMatch(/if (not )?exists/i);
      }
    }
  });

  it('requests pgcrypto for gen_random_uuid', () => {
    expect(schema).toContain('create extension if not exists pgcrypto');
  });

  it('has the supporting indexes the hot queries need', () => {
    for (const idx of [
      'leads_status_idx on leads (status)',
      'sends_due_idx on sends (campaign_id, status, scheduled_for)',
      'events_send_type_idx on events (send_id, type)',
      'events_type_occurred_idx on events (type, occurred_at)',
      'contacts_email_hash_idx on contacts (email_hash)',
      'proofs_status_next_poll_idx on proofs (status, next_poll_at)',
    ]) {
      expect(schema).toContain(idx);
    }
  });

  it('has no suppression reason for a plain send (§7)', () => {
    const enumLine = schema.match(/create type suppression_reason as enum \(([\s\S]*?)\)/);
    expect(enumLine).not.toBeNull();
    expect(enumLine![1]).not.toContain("'sent'");
  });
});
