import type { LeadStatus } from './types';

/**
 * Pure SQL fragment builders. They emit numbered placeholders and a matching
 * parameter array, which is what `sql.unsafe(text, params)` takes, so the
 * queries stay parameterised while the composition itself stays testable
 * without a database.
 */
export interface SqlChunk {
  text: string;
  params: unknown[];
}

export interface LeadFilter {
  status?: LeadStatus;
  dropReason?: string;
  sourceId?: string;
  campaignId?: string;
  jurisdiction?: string;
  q?: string;
  limit?: number;
  offset?: number;
}

export interface SendFilter {
  campaignId?: string;
  status?: string;
  limit?: number;
  offset?: number;
}

/** Bounded so a UI typo cannot ask for the entire table. */
export function clampLimit(limit: number | undefined, fallback: number, max: number): number {
  if (limit === undefined || !Number.isFinite(limit)) return fallback;
  return Math.min(Math.max(Math.trunc(limit), 1), max);
}

export function clampOffset(offset: number | undefined): number {
  if (offset === undefined || !Number.isFinite(offset) || offset < 0) return 0;
  return Math.trunc(offset);
}

/** Escapes the LIKE metacharacters so a search for '100%' is not a wildcard. */
export function likePattern(q: string): string {
  return `%${q.trim().replace(/([\\%_])/g, '\\$1')}%`;
}

/**
 * Builds the WHERE clause for the /leads table. `alias` is the leads alias in
 * the query; `startIndex` is the first placeholder number to use, so the caller
 * can append limit and offset after it.
 */
export function buildLeadWhere(f: LeadFilter, alias = 'l', startIndex = 1): SqlChunk {
  const clauses: string[] = [];
  const params: unknown[] = [];
  let n = startIndex;

  const add = (clause: string, value: unknown): void => {
    clauses.push(clause.replace(/\$\?/g, () => `$${n}`));
    params.push(value);
    n += 1;
  };

  if (f.status !== undefined) add(`${alias}.status = $?`, f.status);
  if (f.dropReason !== undefined) add(`${alias}.drop_reason = $?`, f.dropReason);
  if (f.sourceId !== undefined) add(`${alias}.source_id = $?`, f.sourceId);
  if (f.campaignId !== undefined) add(`${alias}.campaign_id = $?::uuid`, f.campaignId);
  if (f.jurisdiction !== undefined) add(`${alias}.jurisdiction = $?`, f.jurisdiction);

  if (f.q !== undefined && f.q.trim() !== '') {
    // One placeholder reused across the searchable columns, hence the manual
    // clause rather than four calls to add().
    const p = `$${n}`;
    clauses.push(
      `(${alias}.name ilike ${p} or ${alias}.domain ilike ${p} ` +
        `or ${alias}.url ilike ${p} or coalesce(${alias}.description, '') ilike ${p})`,
    );
    params.push(likePattern(f.q));
    n += 1;
  }

  return {
    text: clauses.length ? `where ${clauses.join(' and ')}` : '',
    params,
  };
}

export function buildSendWhere(f: SendFilter, alias = 's', startIndex = 1): SqlChunk {
  const clauses: string[] = [];
  const params: unknown[] = [];
  let n = startIndex;

  if (f.campaignId !== undefined) {
    clauses.push(`${alias}.campaign_id = $${n}::uuid`);
    params.push(f.campaignId);
    n += 1;
  }
  if (f.status !== undefined) {
    clauses.push(`${alias}.status = $${n}`);
    params.push(f.status);
    n += 1;
  }

  return {
    text: clauses.length ? `where ${clauses.join(' and ')}` : '',
    params,
  };
}

/**
 * The send statuses that occupy a contact-once slot, i.e. exactly the statuses
 * in sends_email_hash_uniq's WHERE clause. Anything asking "has this address
 * been contacted" or "is this proof still live" has to use this list and not
 * its own copy: 0002 added 'sending' and three separate hand-written lists had
 * to be found and widened, which is one more than should ever exist.
 *
 * Inlined into SQL rather than parameterised because postgres.js would render
 * an array parameter as a single value in `in (...)`. It is a constant of the
 * schema, not user input.
 */
export const LIVE_SEND_STATUSES = ['queued', 'sending', 'sent'] as const;

/** `'queued','sending','sent'`, ready to drop into an `in (...)`. */
export const LIVE_SEND_STATUS_SQL = LIVE_SEND_STATUSES.map((s) => `'${s}'`).join(',');

/**
 * §8.2 drop reasons that mean the lead did reach `matched` and then died later
 * in the pipeline. Together with a non-null campaign_id these make up the
 * denominator for share_of_matched: a lead dropped as jurisdiction_blocked,
 * no_match or suppressed never got matched, so counting it there would make the
 * contact-once cost look smaller than it is.
 */
export const MATCHED_OR_BEYOND_DROP_REASONS = [
  'contacted_other_campaign',
  'no_contact',
  'no_proof',
  'generator_failed',
] as const;

/** Terminal lead status implied by a drop reason (§8.2). */
export function statusForDropReason(reason: string): LeadStatus {
  switch (reason) {
    case 'no_match':
      return 'no_match';
    case 'no_contact':
      return 'no_contact';
    case 'no_proof':
      return 'no_proof';
    default:
      // jurisdiction_blocked, suppressed, contacted_other_campaign,
      // generator_failed and anything added later.
      return 'dropped';
  }
}
