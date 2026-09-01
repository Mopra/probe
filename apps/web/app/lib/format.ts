/** Tiny class joiner. No dependency, no variants engine. */
export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

const DEFAULT_TZ = 'Europe/Copenhagen';

export function formatDateTime(
  value: Date | string | null | undefined,
  timezone: string = DEFAULT_TZ,
): string {
  const d = toDate(value);
  if (!d) return '-';
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
    .format(d)
    .replace(',', '');
}

export function formatTime(
  value: Date | string | null | undefined,
  timezone: string = DEFAULT_TZ,
): string {
  const d = toDate(value);
  if (!d) return '-';
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(d);
}

export function formatDate(
  value: Date | string | null | undefined,
  timezone: string = DEFAULT_TZ,
): string {
  const d = toDate(value);
  if (!d) return '-';
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

/** '4 min ago', '3 h ago', '2 d ago'. Null renders as 'never'. */
export function relativeAge(value: Date | string | null | undefined, now = new Date()): string {
  const d = toDate(value);
  if (!d) return 'never';
  const ms = now.getTime() - d.getTime();
  const abs = Math.abs(ms);
  const suffix = ms >= 0 ? 'ago' : 'ahead';
  if (abs < 60_000) return `${Math.round(abs / 1000)} s ${suffix}`;
  if (abs < 3_600_000) return `${Math.round(abs / 60_000)} min ${suffix}`;
  if (abs < 86_400_000) return `${Math.round(abs / 3_600_000)} h ${suffix}`;
  return `${Math.round(abs / 86_400_000)} d ${suffix}`;
}

export function toDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Rates are tiny (0.0005 is the complaint threshold), so percent with enough
 *  decimals to be readable against the line. */
export function formatRate(rate: number, digits = 3): string {
  if (!Number.isFinite(rate)) return '-';
  return `${(rate * 100).toFixed(digits)}%`;
}

export function formatShare(share: number): string {
  if (!Number.isFinite(share)) return '-';
  return `${(share * 100).toFixed(1)}%`;
}

export function formatInt(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '-';
  return new Intl.NumberFormat('en-GB').format(n);
}

/** Enough of a hash or token to recognise, never the whole thing. */
export function truncate(value: string | null | undefined, max = 24): string {
  if (!value) return '-';
  return value.length <= max ? value : `${value.slice(0, max)}...`;
}

export function prettyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? 'null';
  } catch {
    return String(value);
  }
}

/** jsonb columns arrive as objects. Flatten one level for a key/value list. */
export function metaEntries(meta: Record<string, unknown> | null | undefined): Array<[string, string]> {
  if (!meta) return [];
  return Object.entries(meta).map(([k, v]) => [
    k,
    typeof v === 'string' ? v : prettyJson(v),
  ]);
}
