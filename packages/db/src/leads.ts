import { first, getSql, rows, unsafeParams } from './client';
import {
  buildLeadWhere,
  clampLimit,
  clampOffset,
  statusForDropReason,
  type LeadFilter,
} from './filters';
import type { DropReasonString, LeadRow, LeadStatus } from './types';

export type { LeadFilter };

export interface NewLead {
  source_id: string;
  external_id: string;
  name: string;
  url: string;
  domain: string;
  description: string | null;
  tags: string[];
  launched_at: Date | null;
}

export interface LeadListItem extends LeadRow {
  campaign_slug: string | null;
  contact_email: string | null;
  proof_status: string | null;
}

/**
 * Two unique indexes guard a lead: (source_id, external_id) and (domain). One
 * statement can only name one conflict target, so the domain half is a guarded
 * insert and the source half is an ON CONFLICT. Returns the row when inserted,
 * null when either guard rejected it.
 *
 * The guard is not a substitute for the index: leads_domain_uniq still decides
 * under concurrency, and a loser there raises rather than silently inserting a
 * duplicate. Sweeps run one at a time, so the race is theoretical.
 */
export async function insertLead(lead: NewLead): Promise<LeadRow | null> {
  const sql = getSql();
  const result = await sql`
    insert into leads (
      source_id, external_id, name, url, domain, description, tags, launched_at
    )
    select
      ${lead.source_id}::text, ${lead.external_id}::text, ${lead.name}::text,
      ${lead.url}::text, ${lead.domain}::text, ${lead.description}::text,
      ${lead.tags}::text[], ${lead.launched_at}::timestamptz
    where not exists (select 1 from leads where domain = ${lead.domain})
    on conflict (source_id, external_id) do nothing
    returning *
  `;
  return first<LeadRow>(result);
}

export async function getLead(id: string): Promise<LeadRow | null> {
  const sql = getSql();
  return first<LeadRow>(await sql`select * from leads where id = ${id}`);
}

/** leads_domain_uniq means a domain identifies a lead. `cli smoke` uses this to
 *  pick up the row a second run could not insert. */
export async function getLeadByDomain(domain: string): Promise<LeadRow | null> {
  const sql = getSql();
  return first<LeadRow>(await sql`select * from leads where domain = ${domain}`);
}

export async function listLeadsByStatus(
  status: LeadStatus,
  limit = 200,
): Promise<LeadRow[]> {
  const sql = getSql();
  return rows<LeadRow>(await sql`
    select * from leads
    where status = ${status}
    order by discovered_at
    limit ${clampLimit(limit, 200, 2000)}
  `);
}

/**
 * Every lead not already dropped, whatever stage it reached.
 *
 * The platform denylist lives in @probe/core as code, so the filtering cannot
 * happen in SQL. This hands the caller the candidates to test in JavaScript,
 * which is why it is deliberately narrow: `cli drop-platforms` cleaning up
 * leads swept before the denylist existed, and nothing else.
 */
export async function listLiveLeads(limit = 2000): Promise<LeadRow[]> {
  const sql = getSql();
  return rows<LeadRow>(await sql`
    select * from leads
     where status <> 'dropped'
     order by discovered_at
     limit ${clampLimit(limit, 2000, 10000)}
  `);
}

export async function setLeadJurisdiction(
  id: string,
  j: { country: string | null; source: string | null; detail?: string | null },
): Promise<void> {
  const sql = getSql();
  // §8.1: recorded either way, including for leads the gate will block. The
  // swept list is an asset in its own right.
  await sql`
    update leads
       set jurisdiction        = ${j.country},
           jurisdiction_source = ${j.source},
           jurisdiction_detail = ${j.detail ?? null}
     where id = ${id}
  `;
}

/**
 * `campaignId` is only written when the argument is present, so passing nothing
 * advances the status without disturbing the routing decision. Passing null
 * clears it deliberately.
 */
export async function setLeadStatus(
  id: string,
  status: LeadStatus,
  campaignId?: string | null,
): Promise<void> {
  const sql = getSql();
  if (campaignId === undefined) {
    await sql`update leads set status = ${status} where id = ${id}`;
    return;
  }
  await sql`
    update leads set status = ${status}, campaign_id = ${campaignId}::uuid where id = ${id}
  `;
}

/**
 * §8.2: the drop reason is written once and never overwritten, so the `where`
 * clause carries the rule rather than a comment asking callers to be careful.
 * A lead dropped as jurisdiction_blocked that later fails a generator call
 * stays jurisdiction_blocked, because that is why it actually died.
 */
export async function dropLead(
  id: string,
  reason: DropReasonString,
  status?: LeadStatus,
): Promise<void> {
  const sql = getSql();
  const finalStatus = status ?? statusForDropReason(reason);
  await sql`
    update leads
       set drop_reason = ${reason},
           status      = ${finalStatus}
     where id = ${id}
       and drop_reason is null
  `;
}

/**
 * Returns leads dropped as `jurisdiction_blocked` whose recorded country the
 * current blocklist does not block, and with `apply` puts them back into the
 * pipeline at `discovered`.
 *
 * The one place drop_reason is ever cleared, and it earns the exception: those
 * leads were not dropped on their own merits but by a rule that has since
 * changed, and without this the only record of the change is a lead that stays
 * dead forever. Nothing else is revived. A lead dropped as `suppressed`,
 * `no_contact` or `contacted_other_campaign` was judged on itself, and a
 * suppression in particular is permanent by rule 2.
 *
 * `null` jurisdiction is included, because under a blocklist unknown is
 * contactable. Under the allowlist that was the majority of every intake.
 */
export async function requalifyJurisdictionDrops(
  blocked: string[],
  opts?: { apply?: boolean },
): Promise<{ domain: string; jurisdiction: string | null }[]> {
  const sql = getSql();
  const upper = blocked.map((c) => c.trim().toUpperCase()).filter((c) => c.length > 0);
  // An empty blocklist would make `not in ()` invalid SQL, so the two cases are
  // written separately rather than papered over with a sentinel value.
  const eligible =
    upper.length > 0
      ? sql`
          select id, domain, jurisdiction from leads
           where status = 'dropped'
             and drop_reason = 'jurisdiction_blocked'
             and (jurisdiction is null or upper(jurisdiction) <> all(${upper}::text[]))
        `
      : sql`
          select id, domain, jurisdiction from leads
           where status = 'dropped'
             and drop_reason = 'jurisdiction_blocked'
        `;
  const found = rows<{ id: string; domain: string; jurisdiction: string | null }>(await eligible);
  if (found.length === 0 || !opts?.apply) {
    return found.map((r) => ({ domain: r.domain, jurisdiction: r.jurisdiction }));
  }

  await sql`
    update leads
       set status = 'discovered',
           drop_reason = null
     where id = any(${found.map((r) => r.id)}::uuid[])
  `;
  return found.map((r) => ({ domain: r.domain, jurisdiction: r.jurisdiction }));
}

const LEAD_LIST_SELECT = `
  select l.*,
         c.slug   as campaign_slug,
         ct.email as contact_email,
         p.status as proof_status
    from leads l
    left join campaigns c on c.id = l.campaign_id
    left join lateral (
      select email from contacts
       where contacts.lead_id = l.id
       order by confidence desc, found_at desc
       limit 1
    ) ct on true
    left join proofs p on p.lead_id = l.id
`;

export async function listLeads(f: LeadFilter): Promise<LeadListItem[]> {
  const sql = getSql();
  const where = buildLeadWhere(f);
  const limit = clampLimit(f.limit, 100, 1000);
  const offset = clampOffset(f.offset);
  const n = where.params.length;

  const text = `${LEAD_LIST_SELECT}
    ${where.text}
    order by l.discovered_at desc
    limit $${n + 1} offset $${n + 2}`;

  return rows<LeadListItem>(
    await sql.unsafe(text, unsafeParams([...where.params, limit, offset])),
  );
}

export async function countLeads(f: LeadFilter): Promise<number> {
  const sql = getSql();
  const where = buildLeadWhere(f);
  const text = `select count(*)::int as n from leads l ${where.text}`;
  const result = await sql.unsafe(text, unsafeParams(where.params));
  return first<{ n: number }>(result)?.n ?? 0;
}
