import { loadEnv } from '@probe/config';
import postgres, { type Sql } from 'postgres';

/**
 * Supabase's transaction pooler multiplexes client connections onto fewer
 * server connections, which makes named prepared statements unusable: the
 * statement can be prepared on one backend and executed on another. Detect it
 * from the host rather than making every caller remember.
 */
export function usesPooler(url: string): boolean {
  try {
    return new URL(url).hostname.toLowerCase().includes('pooler');
  } catch {
    // Not a parseable URL. Fall back to a substring check rather than throwing
    // here; the connection attempt itself will produce the better error.
    return url.toLowerCase().includes('pooler');
  }
}

let sql: Sql | null = null;

/**
 * Lazily creates the single connection pool. Lazy because apps/web is built on
 * Vercel with no database reachable, and a module-level connect would fail the
 * build rather than the request.
 */
export function getSql(): Sql {
  if (sql) return sql;

  const url = loadEnv().SUPABASE_DB_URL;

  sql = postgres(url, {
    // Keep snake_case exactly as the columns are named. The row types in
    // types.ts mirror the schema, so any transform here would be a second
    // naming convention to keep in sync.
    transform: undefined,
    max: 10,
    // Vercel functions are frozen between invocations; an idle socket that the
    // platform reaped looks like a hang on the next request. A short idle
    // timeout makes the pool re-dial instead.
    idle_timeout: 20,
    max_lifetime: 60 * 30,
    connect_timeout: 15,
    prepare: !usesPooler(url),
    onnotice: () => {
      // Postgres notices ('relation already exists, skipping') are expected
      // during migrations and are not worth a log line each.
    },
  });

  return sql;
}

export async function closeSql(): Promise<void> {
  if (!sql) return;
  const current = sql;
  sql = null;
  await current.end({ timeout: 5 });
}

/** Transaction handle. Same interface as the pool, scoped to one transaction. */
export type Tx = Sql;

export async function withTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return getSql().begin(async (tx) => fn(tx as unknown as Tx)) as Promise<T>;
}

/**
 * postgres.js types a result as its own row array. Every query in this package
 * declares the row shape it expects, and this is the single place that cast
 * happens, rather than an `as any` at each call site.
 */
export function rows<T>(result: readonly unknown[]): T[] {
  return result as unknown as T[];
}

/**
 * postgres.js types sql.json() against its own JSONValue union and
 * sql.unsafe() against ParameterOrJSON. Our detail bags and filter builders
 * deal in `unknown`, which is correct at their level. These two helpers are the
 * only place that gap is bridged, instead of a cast at every call site.
 */
export function jsonParam(value: unknown): never {
  return value as never;
}

export function unsafeParams(params: readonly unknown[]): never[] {
  return params as never[];
}

/** First row of a result, or null. */
export function first<T>(result: readonly unknown[]): T | null {
  return (result.length > 0 ? (result[0] as T) : null);
}

/** Postgres unique violation. Used to turn a race into a typed error. */
export const UNIQUE_VIOLATION = '23505';

export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  const e = err as { code?: string; constraint_name?: string; constraint?: string } | null;
  if (!e || e.code !== UNIQUE_VIOLATION) return false;
  if (!constraint) return true;
  return e.constraint_name === constraint || e.constraint === constraint;
}
