import { first, getSql, jsonParam } from './client';

/**
 * Small durable values that must survive a worker restart but do not justify a
 * table each: the match round robin counter (§8.2) and the paid lookup month
 * counter (§8.3).
 */
export async function getState<T>(key: string, fallback: T): Promise<T> {
  const sql = getSql();
  const row = first<{ value: unknown }>(
    await sql`select value from app_state where key = ${key}`,
  );
  return row === null ? fallback : (row.value as T);
}

export async function setState(key: string, value: unknown): Promise<void> {
  const sql = getSql();
  await sql`
    insert into app_state (key, value, updated_at)
    values (${key}, ${sql.json(jsonParam(value))}, now())
    on conflict (key) do update
      set value = excluded.value, updated_at = now()
  `;
}

/**
 * Atomic read-modify-write, done as one statement so two workers incrementing
 * the round robin counter cannot both read the same value. Returns the new one.
 */
export async function bumpCounter(key: string, by = 1): Promise<number> {
  const sql = getSql();
  const result = await sql`
    insert into app_state (key, value, updated_at)
    values (${key}, to_jsonb(${by}::bigint), now())
    on conflict (key) do update
      set value = to_jsonb(
            coalesce((app_state.value #>> '{}')::bigint, 0) + ${by}::bigint
          ),
          updated_at = now()
    returning (value #>> '{}')::bigint as n
  `;
  return Number(first<{ n: string | number }>(result)?.n ?? 0);
}
