import { listCampaigns, listEventsForSend, listSends } from '@probe/db';
import type { EventRow } from '@probe/db';
import { cn, formatDateTime, prettyJson, truncate } from '../lib/format';
import { operatorTimezone } from '../lib/probe';
import { Chip, Empty, Panel, selectClass } from '../lib/ui';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 50;
const SEND_STATUSES = ['queued', 'sent', 'failed', 'cancelled'] as const;
const COLUMNS =
  'grid grid-cols-[10rem_10rem_6.5rem_6rem_minmax(0,1fr)_13rem_5rem] items-start gap-4 px-4';

export default async function SendsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const campaignId = pick(sp.campaign);
  const status = pick(sp.status);
  const page = Math.max(1, Number(pick(sp.page) ?? '1') || 1);

  const timezone = operatorTimezone();
  const [rows, campaigns] = await Promise.all([
    listSends({
      campaignId: campaignId || undefined,
      status: status || undefined,
      limit: PAGE_SIZE,
      offset: (page - 1) * PAGE_SIZE,
    }),
    listCampaigns(),
  ]);

  const trails = await Promise.all(rows.map((r) => listEventsForSend(r.id)));

  const counts = {
    queued: rows.filter((r) => r.status === 'queued').length,
    sent: rows.filter((r) => r.status === 'sent').length,
    failed: rows.filter((r) => r.status === 'failed' || r.status === 'cancelled').length,
  };

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-wrap items-end justify-between gap-4 border-b border-edge pb-4">
        <div className="flex flex-col gap-1">
          <span className="lbl">What went out</span>
          <h1 className="text-2xl font-light tracking-tight">Sends</h1>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Chip>{counts.queued} queued</Chip>
          <Chip tone="signal">{counts.sent} sent</Chip>
          {counts.failed > 0 && <Chip tone="danger">{counts.failed} failed or cancelled</Chip>}
          <span className="font-mono text-[11px] text-faint">on this page</span>
        </div>
      </header>

      <Panel title="Filter">
        <form method="get" className="flex flex-wrap items-end gap-3 py-1">
          <label className="flex w-48 flex-col gap-1.5">
            <span className="lbl">Campaign</span>
            <select name="campaign" defaultValue={campaignId ?? ''} className={selectClass}>
              <option value="">any</option>
              {campaigns.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.slug}
                </option>
              ))}
            </select>
          </label>
          <label className="flex w-48 flex-col gap-1.5">
            <span className="lbl">Status</span>
            <select name="status" defaultValue={status ?? ''} className={selectClass}>
              <option value="">any</option>
              {SEND_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
          <button
            type="submit"
            className="border border-signal-dim bg-signal-dim/25 px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.14em] text-signal hover:bg-signal-dim/45"
          >
            Apply
          </button>
          <a
            href="/sends"
            className="border border-edge-strong bg-raised px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.14em] text-dim hover:border-dim"
          >
            Clear
          </a>
        </form>
      </Panel>

      {rows.length === 0 ? (
        <Empty
          headline="No sends yet."
          hint="A send row appears the moment a proof is approved, scheduled but not yet dispatched. The daemon fills in sent_at and ses_message_id when it hands the message to SES."
        />
      ) : (
        <Panel title="Send log" note="expand a row for its event trail" bodyClassName="">
          <div className="overflow-x-auto">
            <div className="min-w-[74rem]">
              <div className={cn(COLUMNS, 'border-b border-edge py-2')}>
                <span className="lbl">Scheduled for</span>
                <span className="lbl">Sent at</span>
                <span className="lbl">Status</span>
                <span className="lbl">Campaign</span>
                <span className="lbl">Lead and subject</span>
                <span className="lbl">SES message id</span>
                <span className="lbl">Events</span>
              </div>

              {rows.map((send, i) => {
                const events = trails[i] ?? [];
                return (
                  <details key={send.id} className="group border-b border-edge">
                    <summary
                      className={cn(
                        COLUMNS,
                        'py-2.5 hover:bg-raised/60 group-open:bg-raised/40',
                      )}
                    >
                      <span className="font-mono text-[12px] tabular-nums text-dim">
                        {formatDateTime(send.scheduled_for, timezone)}
                      </span>
                      <span className="font-mono text-[12px] tabular-nums text-dim">
                        {send.sent_at ? formatDateTime(send.sent_at, timezone) : 'not yet'}
                      </span>
                      <span>
                        <Chip tone={sendTone(send.status)}>{send.status}</Chip>
                      </span>
                      <span className="font-mono text-[12px] text-dim">{send.campaign_slug}</span>
                      <span className="min-w-0">
                        <span className="block truncate text-[13px] text-fg">{send.lead_name}</span>
                        <span className="block truncate font-mono text-[11px] text-faint">
                          {send.subject ?? 'no subject recorded'}
                        </span>
                        <span className="block truncate font-mono text-[11px] text-faint">
                          {send.contact_email ?? 'address scrubbed'}
                        </span>
                      </span>
                      <span className="font-mono text-[11px] break-all text-faint">
                        {truncate(send.ses_message_id, 28)}
                      </span>
                      <span className="font-mono text-[12px] tabular-nums text-dim">
                        {events.length}
                        <span className="ml-2 text-faint group-open:hidden">show</span>
                        <span className="ml-2 hidden text-faint group-open:inline">hide</span>
                      </span>
                    </summary>

                    <div className="border-t border-edge bg-ink px-4 py-3">
                      {send.error && (
                        <p className="mb-3 border border-danger-dim bg-danger-dim/15 px-3 py-2 font-mono text-[12px] text-danger">
                          {send.error}
                        </p>
                      )}
                      <Trail events={events} timezone={timezone} />
                      <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 font-mono text-[11px] text-faint">
                        <span>send {send.id}</span>
                        <span>proof {send.proof_id}</span>
                        <span>approved by {send.approved_by}</span>
                        <span>approved {formatDateTime(send.approved_at, timezone)}</span>
                        <span>hash {truncate(send.email_hash, 16)}</span>
                      </div>
                    </div>
                  </details>
                );
              })}
            </div>
          </div>

          <div className="flex items-center justify-between gap-4 border-t border-edge px-4 py-2.5">
            <span className="font-mono text-[11px] tabular-nums text-faint">
              rows {(page - 1) * PAGE_SIZE + 1} to {(page - 1) * PAGE_SIZE + rows.length}
            </span>
            <div className="flex items-center gap-2">
              <Pager sp={sp} page={page} delta={-1} disabled={page <= 1} label="Previous" />
              <Pager
                sp={sp}
                page={page}
                delta={1}
                disabled={rows.length < PAGE_SIZE}
                label="Next"
              />
            </div>
          </div>
        </Panel>
      )}
    </div>
  );
}

function Trail({ events, timezone }: { events: EventRow[]; timezone: string }) {
  if (events.length === 0) {
    return (
      <p className="text-[12px] text-faint">
        No events yet. Delivery, bounce, complaint, click, unsubscribe and reply all land here
        through /hooks/ses, apart from clicks and unsubscribes, which this app records itself.
      </p>
    );
  }
  return (
    <ol className="flex flex-col">
      {events.map((ev) => (
        <li
          key={ev.id}
          className="grid grid-cols-[10rem_8rem_minmax(0,1fr)] items-start gap-4 border-b border-edge py-2 last:border-b-0"
        >
          <span className="font-mono text-[12px] tabular-nums text-dim">
            {formatDateTime(ev.occurred_at, timezone)}
          </span>
          <span>
            <Chip tone={eventTone(ev.type)}>{ev.type}</Chip>
          </span>
          <pre className="overflow-x-auto whitespace-pre-wrap break-words font-mono text-[11px] text-faint">
            {prettyJson(ev.detail)}
          </pre>
        </li>
      ))}
    </ol>
  );
}

function sendTone(status: string): 'neutral' | 'signal' | 'warn' | 'danger' {
  if (status === 'sent') return 'signal';
  if (status === 'failed') return 'danger';
  if (status === 'cancelled') return 'warn';
  return 'neutral';
}

function eventTone(type: string): 'neutral' | 'signal' | 'warn' | 'danger' {
  if (type === 'bounce' || type === 'complaint') return 'danger';
  if (type === 'unsubscribe') return 'warn';
  if (type === 'reply' || type === 'click' || type === 'delivery') return 'signal';
  return 'neutral';
}

function pick(v: string | string[] | undefined): string | undefined {
  const value = Array.isArray(v) ? v[0] : v;
  return value && value.length > 0 ? value : undefined;
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
      href={`/sends?${params.toString()}`}
      className="border border-edge-strong bg-raised px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.14em] text-fg hover:border-dim"
    >
      {label}
    </a>
  );
}
