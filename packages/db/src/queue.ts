import { getSql, rows, unsafeParams } from './client';
import { LIVE_SEND_STATUS_SQL, clampLimit } from './filters';
import type { CampaignRow, ContactRow, LeadRow, ProofRow } from './types';

export interface QueueItem {
  proof: ProofRow;
  lead: LeadRow;
  campaign: CampaignRow;
  contact: ContactRow;
}

// Column lists mirror schema.sql. They exist because /queue needs four whole
// rows out of one query and several of them have an `id` and a `status`, so the
// result has to be prefixed rather than relying on postgres.js key names.
const PROOF_COLS = [
  'id', 'lead_id', 'campaign_id', 'subject', 'html', 'text_body', 'fix', 'severity',
  'evidence_url', 'meta', 'attempts', 'polls', 'status', 'error', 'created_at',
  'ready_at', 'first_requested_at', 'next_poll_at',
];
const LEAD_COLS = [
  'id', 'source_id', 'external_id', 'name', 'url', 'domain', 'description', 'tags',
  'launched_at', 'discovered_at', 'jurisdiction', 'jurisdiction_source',
  'jurisdiction_detail', 'status', 'campaign_id', 'drop_reason', 'notes',
];
const CAMPAIGN_COLS = [
  'id', 'slug', 'product', 'generator_url', 'from_name', 'from_email', 'reply_to',
  'paused', 'warmup_start', 'daily_cap', 'timezone', 'exclude_tags',
  'exclude_keywords', 'created_at',
];
const CONTACT_COLS = [
  'id', 'lead_id', 'email', 'email_norm', 'email_hash', 'first_name', 'method',
  'confidence', 'found_at',
];

/** `p.id as p__id, p.lead_id as p__lead_id, …` */
export function prefixedSelect(alias: string, prefix: string, columns: string[]): string {
  return columns.map((c) => `${alias}.${c} as ${prefix}__${c}`).join(', ');
}

/** Pulls one prefixed group back out of a flat result row. */
export function unprefix<T>(row: Record<string, unknown>, prefix: string): T {
  const out: Record<string, unknown> = {};
  const head = `${prefix}__`;
  for (const [key, value] of Object.entries(row)) {
    if (key.startsWith(head)) out[key.slice(head.length)] = value;
  }
  return out as T;
}

const QUEUE_SELECT = [
  prefixedSelect('p', 'p', PROOF_COLS),
  prefixedSelect('l', 'l', LEAD_COLS),
  prefixedSelect('c', 'c', CAMPAIGN_COLS),
  prefixedSelect('ct', 'ct', CONTACT_COLS),
].join(',\n         ');

const QUEUE_FROM = `
    from proofs p
    join leads l     on l.id = p.lead_id
    join campaigns c on c.id = p.campaign_id
    join lateral (
      select * from contacts
       where contacts.lead_id = p.lead_id
       order by confidence desc, found_at desc
       limit 1
    ) ct on true`;

function toItem(row: Record<string, unknown>): QueueItem {
  return {
    proof: unprefix<ProofRow>(row, 'p'),
    lead: unprefix<LeadRow>(row, 'l'),
    campaign: unprefix<CampaignRow>(row, 'c'),
    contact: unprefix<ContactRow>(row, 'ct'),
  };
}

/**
 * §8.5. Proofs that are ready and have no live send row yet, oldest first.
 * A failed or cancelled send returns its proof here, which is what makes a
 * transient SES error recoverable by re-approving.
 */
export async function listQueue(limit = 100): Promise<QueueItem[]> {
  const sql = getSql();
  const result = await sql.unsafe(
    `select ${QUEUE_SELECT}
     ${QUEUE_FROM}
      where p.status = 'ready'
        and l.status <> 'rejected'
        and not exists (
          select 1 from sends s
           where s.proof_id = p.id and s.status in (${LIVE_SEND_STATUS_SQL})
        )
      order by coalesce(p.ready_at, p.created_at)
      limit $1`,
    unsafeParams([clampLimit(limit, 100, 1000)]),
  );
  return rows<Record<string, unknown>>(result).map(toItem);
}

/** The same joins for one proof, with no readiness filter so /queue can also
 *  show an item that has since been approved or rejected. */
export async function getQueueItem(proofId: string): Promise<QueueItem | null> {
  const sql = getSql();
  const result = await sql.unsafe(
    `select ${QUEUE_SELECT} ${QUEUE_FROM} where p.id = $1::uuid limit 1`,
    unsafeParams([proofId]),
  );
  const flat = rows<Record<string, unknown>>(result);
  return flat.length ? toItem(flat[0]) : null;
}
