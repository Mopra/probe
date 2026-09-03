import { loadEnv } from '@probe/config';
import { first, getSql, rows } from './client';
import { LIVE_SEND_STATUS_SQL, MATCHED_OR_BEYOND_DROP_REASONS } from './filters';
import { listSources } from './sources';
import type { SourceRow } from './types';

export interface DashboardStats {
  swept_today: number;
  matched_today: number;
  contacts_today: number;
  proofs_ready: number;
  awaiting_approval: number;
  sent_today: number;
  clicks_today: number;
  replies_today: number;
  sent_total: number;
  campaigns: Array<{
    slug: string;
    paused: boolean;
    warmup_day: number;
    daily_cap: number;
    sent_today: number;
  }>;
  send_enabled: boolean;
}

/**
 * Everything on `/` in two round trips. "Today" is the calendar day in the
 * timezone passed in, not UTC: a send at 23:30 Copenhagen belongs to the day
 * the operator thinks it does.
 */
export async function dashboardStats(timezone: string, now: Date): Promise<DashboardStats> {
  const sql = getSql();

  const totals = first<{
    swept_today: number;
    matched_today: number;
    contacts_today: number;
    proofs_ready: number;
    awaiting_approval: number;
    sent_today: number;
    clicks_today: number;
    replies_today: number;
    sent_total: number;
  }>(await sql`
    with today as (
      select (${now}::timestamptz at time zone ${timezone})::date as d
    )
    select
      (select count(*)::int from leads, today
        where (leads.discovered_at at time zone ${timezone})::date = today.d) as swept_today,
      -- Matched means routed to a campaign. Counted on the day the lead was
      -- swept, since match runs the same morning.
      (select count(*)::int from leads, today
        where leads.campaign_id is not null
          and (leads.discovered_at at time zone ${timezone})::date = today.d) as matched_today,
      (select count(*)::int from contacts, today
        where (contacts.found_at at time zone ${timezone})::date = today.d) as contacts_today,
      (select count(*)::int from proofs where status = 'ready') as proofs_ready,
      (select count(*)::int from proofs p
        where p.status = 'ready'
          and not exists (
            select 1 from sends s
             where s.proof_id = p.id and s.status in (${sql.unsafe(LIVE_SEND_STATUS_SQL)})
          )) as awaiting_approval,
      (select count(*)::int from sends, today
        where sends.status = 'sent' and sends.sent_at is not null
          and (sends.sent_at at time zone ${timezone})::date = today.d) as sent_today,
      (select count(*)::int from events, today
        where events.type = 'click'
          and (events.occurred_at at time zone ${timezone})::date = today.d) as clicks_today,
      (select count(*)::int from events, today
        where events.type = 'reply'
          and (events.occurred_at at time zone ${timezone})::date = today.d) as replies_today,
      (select count(*)::int from sends where status = 'sent') as sent_total
  `);

  const campaigns = rows<{
    slug: string;
    paused: boolean;
    warmup_day: number;
    daily_cap: number;
    sent_today: number;
  }>(await sql`
    select c.slug,
           c.paused,
           c.daily_cap,
           -- §5.4: day 1 is warmup_start itself, and a future start is day 0.
           case
             when c.warmup_start is null then 0
             else greatest(
               0,
               ((${now}::timestamptz at time zone c.timezone)::date - c.warmup_start) + 1
             )
           end::int as warmup_day,
           (select count(*)::int from sends s
             where s.campaign_id = c.id
               and s.status = 'sent'
               and s.sent_at is not null
               and (s.sent_at at time zone c.timezone)::date
                 = (${now}::timestamptz at time zone c.timezone)::date) as sent_today
      from campaigns c
     order by c.created_at, c.slug
  `);

  return {
    swept_today: totals?.swept_today ?? 0,
    matched_today: totals?.matched_today ?? 0,
    contacts_today: totals?.contacts_today ?? 0,
    proofs_ready: totals?.proofs_ready ?? 0,
    awaiting_approval: totals?.awaiting_approval ?? 0,
    sent_today: totals?.sent_today ?? 0,
    clicks_today: totals?.clicks_today ?? 0,
    replies_today: totals?.replies_today ?? 0,
    sent_total: totals?.sent_total ?? 0,
    campaigns,
    // §3.1 rule 4. Shown next to the numbers so nobody reads a quiet day as a
    // dead pipeline when the kill switch is simply off.
    send_enabled: loadEnv().PROBE_SEND_ENABLED,
  };
}

export interface HealthStats {
  sources: SourceRow[];
  generator: { ready: number; no_proof: number; failed: number; pending: number };
  rates: {
    window_days: number;
    sent: number;
    bounces: number;
    complaints: number;
    bounce_rate: number;
    complaint_rate: number;
  };
  /** `share_of_matched` is null for a reason that drops a lead before it is
   *  matched, because the matched denominator does not contain those leads. */
  drop_reasons: Array<{ reason: string; count: number; share_of_matched: number | null }>;
  jurisdiction: {
    swept: number;
    blocked: number;
    share_blocked: number;
    top_countries: Array<{ country: string | null; count: number }>;
  };
  contacted_other_campaign: { count: number; share_of_matched: number };
}

/**
 * The denominator for every `share_of_matched` on this page is the number of
 * leads that ever reached `matched` or beyond: leads with a non-null
 * campaign_id, plus leads dropped for a reason that can only occur after
 * matching (contacted_other_campaign, no_contact, no_proof, generator_failed).
 *
 * Leads dropped as jurisdiction_blocked, no_match or suppressed are excluded
 * because they never got matched, and counting them would make the §3.2 cost
 * look smaller than it is. §8.2 says that number decides whether contact-once
 * stays, so it has to be the honest one.
 */
async function matchedDenominator(): Promise<number> {
  const sql = getSql();
  const result = await sql`
    select count(*)::int as n
      from leads
     where campaign_id is not null
        or drop_reason in ${sql(MATCHED_OR_BEYOND_DROP_REASONS as unknown as string[])}
  `;
  return first<{ n: number }>(result)?.n ?? 0;
}

function share(part: number, whole: number): number {
  return whole > 0 ? part / whole : 0;
}

export async function healthStats(windowDays: number): Promise<HealthStats> {
  const sql = getSql();
  const days = Math.max(1, Math.trunc(windowDays));

  const [sources, matched] = await Promise.all([listSources(), matchedDenominator()]);

  const generator = first<{
    ready: number;
    no_proof: number;
    failed: number;
    pending: number;
  }>(await sql`
    select
      (count(*) filter (where status = 'ready'))::int    as ready,
      (count(*) filter (where status = 'no_proof'))::int as no_proof,
      (count(*) filter (where status = 'failed'))::int   as failed,
      (count(*) filter (where status = 'pending'))::int  as pending
    from proofs
  `);

  const rateRow = first<{ sent: number; bounces: number; complaints: number }>(await sql`
    select
      (select count(*)::int from sends
        where status = 'sent' and sent_at >= now() - ${days}::int * interval '1 day') as sent,
      -- Bounces and complaints are counted over the same window as the sends
      -- they refer to, which is what §5.5 compares against the thresholds.
      --
      -- HARD bounces only. §5.5's threshold is a hard bounce rate, and a
      -- transient bounce is a full mailbox or a greylist: counting those here
      -- would auto-pause a campaign because a founder went on holiday with a
      -- full inbox. The bounce event is still recorded either way, so the soft
      -- ones stay visible in the event trail on /sends.
      (select count(*)::int from events
        where type = 'bounce'
          and detail->>'bounce_type' = 'Permanent'
          and occurred_at >= now() - ${days}::int * interval '1 day') as bounces,
      (select count(*)::int from events
        where type = 'complaint' and occurred_at >= now() - ${days}::int * interval '1 day') as complaints
  `);

  const dropRows = rows<{ reason: string; count: number }>(await sql`
    select drop_reason as reason, count(*)::int as count
      from leads
     where drop_reason is not null
     group by drop_reason
     order by count desc, drop_reason
  `);

  const jurisdictionRow = first<{ swept: number; blocked: number }>(await sql`
    select
      (select count(*)::int from leads) as swept,
      (select count(*)::int from leads where drop_reason = 'jurisdiction_blocked') as blocked
  `);

  const topCountries = rows<{ country: string | null; count: number }>(await sql`
    select jurisdiction as country, count(*)::int as count
      from leads
     group by jurisdiction
     order by count desc, jurisdiction nulls last
     limit 10
  `);

  const sent = rateRow?.sent ?? 0;
  const bounces = rateRow?.bounces ?? 0;
  const complaints = rateRow?.complaints ?? 0;
  const swept = jurisdictionRow?.swept ?? 0;
  const blocked = jurisdictionRow?.blocked ?? 0;
  const contactedOther = dropRows.find((r) => r.reason === 'contacted_other_campaign');

  return {
    sources,
    generator: {
      ready: generator?.ready ?? 0,
      no_proof: generator?.no_proof ?? 0,
      failed: generator?.failed ?? 0,
      pending: generator?.pending ?? 0,
    },
    rates: {
      window_days: days,
      sent,
      bounces,
      complaints,
      bounce_rate: share(bounces, sent),
      complaint_rate: share(complaints, sent),
    },
    drop_reasons: dropRows.map((r) => ({
      reason: r.reason,
      count: r.count,
      // Only for reasons the denominator actually contains. jurisdiction_blocked,
      // no_match and suppressed drop a lead before it is matched, and dividing
      // them by the matched count printed 3050% on a morning where 61 leads
      // were blocked at the gate and 2 were matched. The jurisdiction gate has
      // its own line below, over swept, which is the honest denominator for it.
      share_of_matched: (MATCHED_OR_BEYOND_DROP_REASONS as readonly string[]).includes(r.reason)
        ? share(r.count, matched)
        : null,
    })),
    jurisdiction: {
      swept,
      blocked,
      // §15.6: the denominator here is every swept lead, not matched leads.
      // The question this answers is what US-only costs across the whole
      // intake, and the gate runs before matching.
      share_blocked: share(blocked, swept),
      top_countries: topCountries,
    },
    contacted_other_campaign: {
      count: contactedOther?.count ?? 0,
      share_of_matched: share(contactedOther?.count ?? 0, matched),
    },
  };
}

/** §5.5 auto-pause input, per campaign. */
export async function rollingRates(
  campaignId: string,
  days: number,
): Promise<{
  sent: number;
  bounces: number;
  complaints: number;
  bounce_rate: number;
  complaint_rate: number;
}> {
  const sql = getSql();
  const window = Math.max(1, Math.trunc(days));

  const row = first<{ sent: number; bounces: number; complaints: number }>(await sql`
    with recent as (
      select id from sends
       where campaign_id = ${campaignId}::uuid
         and status = 'sent'
         and sent_at >= now() - ${window}::int * interval '1 day'
    )
    select
      (select count(*)::int from recent) as sent,
      -- Scoped to this campaign's own sends: each sending subdomain is a
      -- separate reputation (§5.4) and must be paused on its own numbers.
      --
      -- Hard bounces only, for the same reason as healthStats: this number is
      -- compared against bounce_rate_threshold, which §5.5 defines as a hard
      -- bounce rate. Auto-pausing on soft bounces would train the operator to
      -- ignore the pause, which is worse than not having one.
      (select count(*)::int from events
        where type = 'bounce'
          and detail->>'bounce_type' = 'Permanent'
          and send_id in (select id from recent)) as bounces,
      (select count(*)::int from events
        where type = 'complaint' and send_id in (select id from recent)) as complaints
  `);

  const sent = row?.sent ?? 0;
  const bounces = row?.bounces ?? 0;
  const complaints = row?.complaints ?? 0;

  return {
    sent,
    bounces,
    complaints,
    bounce_rate: share(bounces, sent),
    complaint_rate: share(complaints, sent),
  };
}
