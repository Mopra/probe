import { capForWarmupDay } from '@probe/core';
import { dashboardStats, listCampaigns } from '@probe/db';
import type { CampaignRow, DashboardStats } from '@probe/db';
import { pauseEverything, setPaused, startCampaignWarmup } from './actions';
import { cn, formatDate, formatInt } from './lib/format';
import { operatorTimezone, sendEnabled } from './lib/probe';
import { Button, Chip, Empty, Panel, Stat, TD, TH } from './lib/ui';

export const dynamic = 'force-dynamic';

export default async function DashboardPage() {
  const timezone = operatorTimezone();
  const now = new Date();

  const [stats, campaigns] = await Promise.all([
    dashboardStats(timezone, now),
    listCampaigns(),
  ]);

  const envGate = sendEnabled();
  const live = stats.campaigns.filter((c) => !c.paused).length;
  const bySlug = new Map<string, CampaignRow>(campaigns.map((c) => [c.slug, c]));

  return (
    <div className="flex flex-col gap-6">
      <PageHead timezone={timezone} now={now} />

      <div className="grid gap-4 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,2fr)]">
        <Panel title="Awaiting approval" note="nothing schedules itself">
          <div className="flex flex-col gap-5 py-2">
            <Stat
              label="in the queue right now"
              value={formatInt(stats.awaiting_approval)}
              size="lg"
              tone={stats.awaiting_approval > 0 ? 'signal' : 'quiet'}
              sub={`${formatInt(stats.proofs_ready)} proofs ready today`}
            />
            <a
              href="/queue"
              className="inline-flex w-fit items-center gap-2 border border-signal-dim bg-signal-dim/25 px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.14em] text-signal transition-colors hover:bg-signal-dim/45"
            >
              Open queue
            </a>
          </div>
        </Panel>

        <Interlock
          envGate={envGate}
          liveCampaigns={live}
          totalCampaigns={stats.campaigns.length}
          warmedCampaigns={stats.campaigns.filter((c) => c.warmup_day > 0).length}
        />
      </div>

      <Panel title="Today" note={`${formatDate(now, timezone)} in ${timezone}`}>
        <div className="grid grid-cols-2 gap-x-6 gap-y-7 py-2 sm:grid-cols-4 xl:grid-cols-8">
          <Stat label="Swept" value={formatInt(stats.swept_today)} size="sm" />
          <Stat label="Matched" value={formatInt(stats.matched_today)} size="sm" />
          <Stat label="Contacts found" value={formatInt(stats.contacts_today)} size="sm" />
          <Stat label="Proofs ready" value={formatInt(stats.proofs_ready)} size="sm" />
          <Stat
            label="Awaiting approval"
            value={formatInt(stats.awaiting_approval)}
            size="sm"
            tone={stats.awaiting_approval > 0 ? 'signal' : 'default'}
          />
          <Stat label="Sent" value={formatInt(stats.sent_today)} size="sm" />
          <Stat label="Clicks" value={formatInt(stats.clicks_today)} size="sm" />
          <Stat
            label="Replies"
            value={formatInt(stats.replies_today)}
            size="sm"
            tone={stats.replies_today > 0 ? 'signal' : 'default'}
            sub={`${formatInt(stats.sent_total)} sent all time`}
          />
        </div>
      </Panel>

      <Campaigns stats={stats} bySlug={bySlug} />
    </div>
  );
}

function PageHead({ timezone, now }: { timezone: string; now: Date }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4 border-b border-edge pb-4">
      <div className="flex flex-col gap-1">
        <span className="lbl">Operator console</span>
        <h1 className="text-2xl font-light tracking-tight">Today</h1>
      </div>
      <p className="max-w-md text-xs leading-relaxed text-faint">
        Every number here is scoped to {formatDate(now, timezone)} in {timezone}, except the all
        time total. Nothing on this screen sends anything.
      </p>
    </div>
  );
}

/**
 * The signature of this console: the gates that decide whether mail can leave,
 * drawn in series. They are independent, and the whole point of the diagram is
 * that closing one of them changes nothing on its own.
 *
 * Warmup is drawn here as gate 3 because it is the one that fails silently. An
 * unstarted warmup means dailyCap() is 0, so the send loop reports cap_reached
 * forever and the operator sees a queue that never moves with no error anywhere.
 * The other two announce themselves; this one has to be shown.
 */
function Interlock({
  envGate,
  liveCampaigns,
  totalCampaigns,
  warmedCampaigns,
}: {
  envGate: boolean | null;
  liveCampaigns: number;
  totalCampaigns: number;
  warmedCampaigns: number;
}) {
  const gate1 = envGate === true;
  const gate2 = liveCampaigns > 0;
  const gate3 = warmedCampaigns > 0;
  const open = gate1 && gate2 && gate3;

  return (
    <Panel
      title="Dispatch interlock"
      note="two gates in series, both must be closed"
      actions={
        <form action={pauseEverything}>
          <Button tone="danger" title="Sets campaigns.paused = true for every campaign">
            Pause everything
          </Button>
        </form>
      }
    >
      <div className="flex flex-col gap-4 py-2">
        <div className="flex flex-col items-stretch gap-3 lg:flex-row lg:items-center">
          <GateNode
            label="Gate 1  env"
            name="PROBE_SEND_ENABLED"
            closed={gate1}
            state={envGate === null ? 'unreadable' : envGate ? 'true' : 'false'}
            note="Checked before every single send."
          />
          <Link closed={gate1} />
          <GateNode
            label="Gate 2  db"
            name="campaigns.paused"
            closed={gate2}
            state={`${liveCampaigns} of ${totalCampaigns} live`}
            note="Campaigns are born paused."
          />
          <Link closed={gate1 && gate2} />
          <GateNode
            label="Gate 3  db"
            name="campaigns.warmup_start"
            closed={gate3}
            state={`${warmedCampaigns} of ${totalCampaigns} started`}
            note={
              gate3
                ? 'The warmup curve caps each day.'
                : 'Not set means cap 0: nothing sends, however much is queued.'
            }
          />
          <Link closed={open} />
          <div
            className={cn(
              'flex min-w-[11rem] flex-col gap-1 border px-3 py-2.5',
              open ? 'border-signal-dim bg-signal-dim/15' : 'border-edge bg-raised',
            )}
          >
            <span className="lbl">Result</span>
            <span
              className={cn(
                'font-mono text-sm uppercase tracking-[0.1em]',
                open ? 'text-signal' : 'text-warn',
              )}
            >
              {open ? 'mail can leave' : 'mail blocked'}
            </span>
            <span className="text-[11px] text-faint">
              {open
                ? 'The daemon will dispatch due rows inside the window.'
                : !gate3 && gate1 && gate2
                  ? 'Warmup has not started, so the cap is 0. Start it in the table below.'
                  : 'Approvals still queue. Nothing dispatches.'}
            </span>
          </div>
        </div>

        <p className="max-w-3xl text-xs leading-relaxed text-faint">
          All three gates are independent. Resuming a campaign does not enable sending, setting
          PROBE_SEND_ENABLED to true does not resume a paused campaign, and starting warmup does
          neither. Approval writes a scheduled row whatever they say, so the queue keeps moving
          while the wire is cut.
        </p>
      </div>
    </Panel>
  );
}

function GateNode({
  label,
  name,
  closed,
  state,
  note,
}: {
  label: string;
  name: string;
  closed: boolean;
  state: string;
  note: string;
}) {
  return (
    <div
      className={cn(
        'flex min-w-[12rem] flex-col gap-1 border px-3 py-2.5',
        closed ? 'border-signal-dim bg-signal-dim/10' : 'border-warn-dim bg-warn-dim/10',
      )}
    >
      <span className="lbl">{label}</span>
      <span className="font-mono text-[12px] text-dim">{name}</span>
      <span
        className={cn(
          'font-mono text-sm tracking-[0.06em]',
          closed ? 'text-signal' : 'text-warn',
        )}
      >
        {state}
        <span className="ml-2 text-[10px] uppercase tracking-[0.18em]">
          {closed ? 'closed' : 'open'}
        </span>
      </span>
      <span className="text-[11px] text-faint">{note}</span>
    </div>
  );
}

function Link({ closed }: { closed: boolean }) {
  return (
    <div
      aria-hidden="true"
      className="flex shrink-0 items-center gap-1 lg:w-16 lg:flex-1 lg:max-w-24"
    >
      {closed ? (
        <span className="h-px w-full bg-signal-dim" />
      ) : (
        <>
          <span className="h-px flex-1 border-t border-dashed border-warn-dim" />
          <span className="font-mono text-[10px] text-warn">/</span>
          <span className="font-mono text-[10px] text-warn">/</span>
          <span className="h-px flex-1 border-t border-dashed border-warn-dim" />
        </>
      )}
    </div>
  );
}

function Campaigns({
  stats,
  bySlug,
}: {
  stats: DashboardStats;
  bySlug: Map<string, CampaignRow>;
}) {
  if (stats.campaigns.length === 0) {
    return (
      <Panel title="Campaigns">
        <Empty
          headline="No campaigns in the database yet."
          hint="probe.toml seeds them. Run the worker seed job and they appear here, born paused."
        />
      </Panel>
    );
  }

  return (
    <Panel title="Campaigns" note="probe.toml seeds these, the database rules them" bodyClassName="">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[52rem]">
          <thead>
            <tr>
              <TH>Campaign</TH>
              <TH>From</TH>
              <TH>State</TH>
              <TH align="right">Warmup day</TH>
              <TH align="right">Cap today</TH>
              <TH align="right">Sent today</TH>
              <TH align="right">Remaining</TH>
              <TH align="right">Action</TH>
            </tr>
          </thead>
          <tbody>
            {stats.campaigns.map((c) => {
              const row = bySlug.get(c.slug);
              // §5.4. The cap that actually applies today is min(warmup tier,
              // daily_cap), not daily_cap. Showing daily_cap here read as "50
              // remaining" on warmup day one, when the real ceiling was 5, and
              // this is the number the operator watches on the first sending
              // morning.
              const capToday = capForWarmupDay(c.warmup_day, c.daily_cap);
              const remaining = Math.max(0, capToday - c.sent_today);
              const warmupStarted = c.warmup_day > 0;
              return (
                <tr key={c.slug} className="hover:bg-raised/60">
                  <TD>
                    <span className="font-mono text-[13px] text-fg">{c.slug}</span>
                    {row && <div className="text-[11px] text-faint">{row.product}</div>}
                  </TD>
                  <TD mono>{row ? row.from_email : '-'}</TD>
                  <TD>
                    {c.paused ? (
                      <Chip tone="warn">paused</Chip>
                    ) : (
                      <Chip tone="signal">live</Chip>
                    )}
                  </TD>
                  <TD mono align="right" className={warmupStarted ? undefined : 'text-warn'}>
                    {warmupStarted ? c.warmup_day : 'not started'}
                  </TD>
                  <TD mono align="right" className={capToday === 0 ? 'text-warn' : undefined}>
                    {formatInt(capToday)}
                    {warmupStarted && capToday !== c.daily_cap && (
                      <span className="ml-1 text-[10px] text-faint">of {formatInt(c.daily_cap)}</span>
                    )}
                  </TD>
                  <TD mono align="right">
                    {formatInt(c.sent_today)}
                  </TD>
                  <TD mono align="right" className={remaining === 0 ? 'text-warn' : undefined}>
                    {formatInt(remaining)}
                  </TD>
                  <TD align="right">
                    {row ? (
                      <span className="inline-flex gap-2">
                        {!warmupStarted && (
                          <form action={startCampaignWarmup} className="inline-flex">
                            <input type="hidden" name="campaign_id" value={row.id} />
                            <Button
                              tone="signal"
                              title="Sets warmup_start to today. Until this is set the daily cap is 0 and nothing sends, however much is queued. Does not unpause."
                            >
                              Start warmup
                            </Button>
                          </form>
                        )}
                        <form action={setPaused} className="inline-flex">
                          <input type="hidden" name="campaign_id" value={row.id} />
                          <input type="hidden" name="paused" value={c.paused ? 'false' : 'true'} />
                          <Button tone={c.paused ? 'signal' : 'default'}>
                            {c.paused ? 'Resume' : 'Pause'}
                          </Button>
                        </form>
                      </span>
                    ) : (
                      <span className="text-xs text-faint">no row</span>
                    )}
                  </TD>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}
