import { DROP_REASONS, DROP_REASON_LABELS } from '@probe/core';
import type { DropReason } from '@probe/core';
import { countLeads, listCampaigns, listLeads, listSources } from '@probe/db';
import type { LeadFilter, LeadStatus } from '@probe/db';
import { cn, formatDateTime, formatInt } from '../lib/format';
import { operatorTimezone } from '../lib/probe';
import { Chip, Empty, Panel, Stat, TD, TH, inputClass, selectClass } from '../lib/ui';

export const dynamic = 'force-dynamic';

const LEAD_STATUSES: LeadStatus[] = [
  'discovered',
  'contact_resolved',
  'no_contact',
  'matched',
  'no_match',
  'generating',
  'ready',
  'approved',
  'sent',
  'rejected',
  'no_proof',
  'dropped',
];

const PAGE_SIZE = 50;

export default async function LeadsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const status = pick(sp.status);
  const dropReason = pick(sp.drop_reason);
  const sourceId = pick(sp.source);
  const campaignId = pick(sp.campaign);
  const jurisdiction = pick(sp.jurisdiction);
  const q = pick(sp.q);
  const page = Math.max(1, Number(pick(sp.page) ?? '1') || 1);

  const filter: LeadFilter = {
    status: status ? (status as LeadStatus) : undefined,
    dropReason: dropReason || undefined,
    sourceId: sourceId || undefined,
    campaignId: campaignId || undefined,
    jurisdiction: jurisdiction || undefined,
    q: q || undefined,
    limit: PAGE_SIZE,
    offset: (page - 1) * PAGE_SIZE,
  };

  const timezone = operatorTimezone();
  const [rows, total, sources, campaigns] = await Promise.all([
    listLeads(filter),
    countLeads(filter),
    listSources(),
    listCampaigns(),
  ]);

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const filtered =
    Boolean(status || dropReason || sourceId || campaignId || jurisdiction || q);

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-wrap items-end justify-between gap-4 border-b border-edge pb-4">
        <div className="flex flex-col gap-1">
          <span className="lbl">Drop accounting</span>
          <h1 className="text-2xl font-light tracking-tight">Leads</h1>
        </div>
        <p className="max-w-lg text-xs leading-relaxed text-faint">
          Every lead is stored, always. Jurisdiction, matching and suppression decide what probe
          does with a lead, never whether it is recorded. This screen exists to answer one
          question: why did this drop.
        </p>
      </header>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,0.6fr)_minmax(0,3fr)]">
        <Panel title="Matching this filter">
          <div className="py-2">
            <Stat
              label={filtered ? 'filtered leads' : 'all leads'}
              value={formatInt(total)}
              size="lg"
              tone={total > 0 ? 'default' : 'quiet'}
              sub={`page ${page} of ${pages}`}
            />
          </div>
        </Panel>

        <Panel title="Filter" note="plain GET form, every filter is a query param">
          <form method="get" className="grid gap-3 py-1 sm:grid-cols-2 xl:grid-cols-6">
            <Select name="status" label="Status" value={status} options={LEAD_STATUSES} />
            <Select
              name="drop_reason"
              label="Drop reason"
              value={dropReason}
              options={DROP_REASONS}
              labelFor={(r) => DROP_REASON_LABELS[r as DropReason] ?? r}
            />
            <Select
              name="source"
              label="Source"
              value={sourceId}
              options={sources.map((s) => s.id)}
            />
            <Select
              name="campaign"
              label="Campaign"
              value={campaignId}
              options={campaigns.map((c) => c.id)}
              labelFor={(id) => campaigns.find((c) => c.id === id)?.slug ?? id}
            />
            <label className="flex flex-col gap-1.5">
              <span className="lbl">Jurisdiction</span>
              <input
                type="text"
                name="jurisdiction"
                defaultValue={jurisdiction ?? ''}
                placeholder="US"
                maxLength={2}
                className={inputClass}
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="lbl">Free text</span>
              <input
                type="search"
                name="q"
                defaultValue={q ?? ''}
                placeholder="name, domain, url"
                className={inputClass}
              />
            </label>
            <div className="flex items-end gap-2 sm:col-span-2 xl:col-span-6">
              <button
                type="submit"
                className="border border-signal-dim bg-signal-dim/25 px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.14em] text-signal hover:bg-signal-dim/45"
              >
                Apply
              </button>
              <a
                href="/leads"
                className="border border-edge-strong bg-raised px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.14em] text-dim hover:border-dim"
              >
                Clear
              </a>
            </div>
          </form>
        </Panel>
      </div>

      {rows.length === 0 ? (
        <Empty
          headline={filtered ? 'No leads match this filter.' : 'No leads swept yet.'}
          hint={
            filtered
              ? 'Clear the filter to see everything that has been swept.'
              : 'The sweep job runs at 06:30 and writes every launch it finds, contactable or not.'
          }
        />
      ) : (
        <Panel title="Leads" note={`${rows.length} shown of ${formatInt(total)}`} bodyClassName="">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[72rem]">
              <thead>
                <tr>
                  <TH>Product</TH>
                  <TH>Domain</TH>
                  <TH>Source</TH>
                  <TH>Status</TH>
                  <TH>Drop reason</TH>
                  <TH>Jurisdiction</TH>
                  <TH>Campaign</TH>
                  <TH>Contact</TH>
                  <TH>Proof</TH>
                  <TH align="right">Discovered</TH>
                </tr>
              </thead>
              <tbody>
                {rows.map((lead) => (
                  <tr key={lead.id} className="hover:bg-raised/60">
                    <TD>
                      <span className="text-fg">{lead.name}</span>
                      {lead.description && (
                        <div className="mt-0.5 max-w-md truncate text-[11px] text-faint">
                          {lead.description}
                        </div>
                      )}
                    </TD>
                    <TD mono>
                      <a
                        href={lead.url}
                        target="_blank"
                        rel="noreferrer"
                        className="text-dim underline underline-offset-2 hover:text-signal"
                      >
                        {lead.domain}
                      </a>
                    </TD>
                    <TD mono>{lead.source_id}</TD>
                    <TD>
                      <Chip tone={statusTone(lead.status)}>{lead.status}</Chip>
                    </TD>
                    <TD>
                      {lead.drop_reason ? (
                        <span className="flex flex-col gap-0.5">
                          <span
                            className={cn(
                              'font-mono text-[11px]',
                              lead.drop_reason === 'contacted_other_campaign'
                                ? 'text-warn'
                                : 'text-dim',
                            )}
                          >
                            {lead.drop_reason}
                          </span>
                          <span className="text-[11px] text-faint">
                            {DROP_REASON_LABELS[lead.drop_reason as DropReason] ?? 'not a known reason'}
                          </span>
                        </span>
                      ) : (
                        <span className="text-[11px] text-faint">still alive</span>
                      )}
                    </TD>
                    <TD mono>
                      <span className={lead.jurisdiction ? 'text-dim' : 'text-warn'}>
                        {lead.jurisdiction ?? 'unknown'}
                      </span>
                      <div className="text-[11px] text-faint">
                        {lead.jurisdiction_source ?? 'no signal'}
                      </div>
                    </TD>
                    <TD mono>{lead.campaign_slug ?? '-'}</TD>
                    <TD mono>{lead.contact_email ?? '-'}</TD>
                    <TD mono>{lead.proof_status ?? '-'}</TD>
                    <TD mono align="right">
                      {formatDateTime(lead.discovered_at, timezone)}
                    </TD>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex items-center justify-between gap-4 border-t border-edge px-4 py-2.5">
            <span className="font-mono text-[11px] tabular-nums text-faint">
              rows {(page - 1) * PAGE_SIZE + 1} to {(page - 1) * PAGE_SIZE + rows.length} of{' '}
              {formatInt(total)}
            </span>
            <div className="flex items-center gap-2">
              <Pager sp={sp} page={page} delta={-1} disabled={page <= 1} label="Previous" />
              <Pager sp={sp} page={page} delta={1} disabled={page >= pages} label="Next" />
            </div>
          </div>
        </Panel>
      )}
    </div>
  );
}

function pick(v: string | string[] | undefined): string | undefined {
  const value = Array.isArray(v) ? v[0] : v;
  return value && value.length > 0 ? value : undefined;
}

function statusTone(status: string): 'neutral' | 'signal' | 'warn' | 'danger' {
  if (status === 'sent' || status === 'approved' || status === 'ready') return 'signal';
  if (status === 'rejected' || status === 'dropped') return 'danger';
  if (status === 'no_match' || status === 'no_contact' || status === 'no_proof') return 'warn';
  return 'neutral';
}

function Select({
  name,
  label,
  value,
  options,
  labelFor,
}: {
  name: string;
  label: string;
  value?: string;
  options: readonly string[];
  labelFor?: (v: string) => string;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="lbl">{label}</span>
      <select name={name} defaultValue={value ?? ''} className={selectClass}>
        <option value="">any</option>
        {options.map((o) => (
          <option key={o} value={o}>
            {labelFor ? labelFor(o) : o}
          </option>
        ))}
      </select>
    </label>
  );
}

function Pager({
  sp,
  page,
  delta,
  disabled,
  label,
}: {
  sp: Record<string, string | string[] | undefined>;
  page: number;
  delta: number;
  disabled: boolean;
  label: string;
}) {
  if (disabled) {
    return (
      <span className="border border-edge px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.14em] text-faint opacity-40">
        {label}
      </span>
    );
  }
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    const value = Array.isArray(v) ? v[0] : v;
    if (k !== 'page' && value) params.set(k, value);
  }
  params.set('page', String(page + delta));
  return (
    <a
      href={`/leads?${params.toString()}`}
      className="border border-edge-strong bg-raised px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.14em] text-fg hover:border-dim"
    >
      {label}
    </a>
  );
}
