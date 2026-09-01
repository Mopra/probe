import { healthStats } from '@probe/db';
import type { HealthStats } from '@probe/db';
import { DROP_REASON_LABELS } from '@probe/core';
import type { DropReason } from '@probe/core';
import { cn, formatDateTime, formatInt, formatRate, formatShare, relativeAge } from '../lib/format';
import { globalConfig, operatorTimezone } from '../lib/probe';
import { Chip, Empty, Meter, Panel, Stat, TD, TH } from '../lib/ui';

export const dynamic = 'force-dynamic';

const FALLBACK = {
  complaint_rate_threshold: 0.0005,
  bounce_rate_threshold: 0.03,
  rate_window_days: 7,
};

export default async function HealthPage() {
  const cfg = globalConfig();
  const timezone = operatorTimezone();
  const complaintThreshold = cfg?.complaint_rate_threshold ?? FALLBACK.complaint_rate_threshold;
  const bounceThreshold = cfg?.bounce_rate_threshold ?? FALLBACK.bounce_rate_threshold;
  const windowDays = cfg?.rate_window_days ?? FALLBACK.rate_window_days;

  const stats = await healthStats(windowDays);
  const gen = stats.generator;
  const genTotal = gen.ready + gen.no_proof + gen.failed + gen.pending;
  const genSettled = gen.ready + gen.no_proof + gen.failed;
  const successRate = genSettled > 0 ? gen.ready / genSettled : 0;

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-wrap items-end justify-between gap-4 border-b border-edge pb-4">
        <div className="flex flex-col gap-1">
          <span className="lbl">Instrumentation</span>
          <h1 className="text-2xl font-light tracking-tight">Health</h1>
        </div>
        <p className="max-w-lg text-xs leading-relaxed text-faint">
          Rolling window is {stats.rates.window_days} days, matching the auto pause check. Both
          thresholds below are half of the AWS numbers, so a problem shows up here before SES acts
          on it.
        </p>
      </header>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,0.8fr)]">
        <Panel title="Complaint rate" note={`${stats.rates.window_days} day rolling`}>
          <div className="py-3">
            <Meter
              label="complaints over sends"
              value={stats.rates.complaint_rate}
              threshold={complaintThreshold}
              format={(n) => formatRate(n, 4)}
            />
            <p className="mt-3 font-mono text-[11px] tabular-nums text-faint">
              {formatInt(stats.rates.complaints)} complaints over {formatInt(stats.rates.sent)}{' '}
              sends
            </p>
          </div>
        </Panel>

        <Panel title="Bounce rate" note={`${stats.rates.window_days} day rolling`}>
          <div className="py-3">
            <Meter
              label="hard bounces over sends"
              value={stats.rates.bounce_rate}
              threshold={bounceThreshold}
              format={(n) => formatRate(n, 2)}
            />
            <p className="mt-3 font-mono text-[11px] tabular-nums text-faint">
              {formatInt(stats.rates.bounces)} bounces over {formatInt(stats.rates.sent)} sends
            </p>
          </div>
        </Panel>

        <Panel title="Generator outcomes" note="a clean site is the expected answer">
          <div className="flex flex-col gap-4 py-2">
            <Stat
              label="produced a mailable finding"
              value={genSettled > 0 ? formatShare(successRate) : 'no data'}
              size="md"
              tone={genSettled === 0 ? 'quiet' : 'default'}
              sub={`${formatInt(gen.ready)} ready of ${formatInt(genSettled)} settled`}
            />
            <div className="flex flex-wrap gap-2">
              <Chip tone="signal">{gen.ready} ready</Chip>
              <Chip>{gen.no_proof} no proof</Chip>
              <Chip tone="danger">{gen.failed} failed</Chip>
              <Chip tone="warn">{gen.pending} pending</Chip>
              <Chip tone="ghost">{genTotal} total</Chip>
            </div>
          </div>
        </Panel>
      </div>

      <ContactedOnce stats={stats} />

      <div className="grid gap-4 xl:grid-cols-2">
        <DropReasons stats={stats} />
        <Jurisdiction stats={stats} />
      </div>

      <Sources stats={stats} timezone={timezone} />
    </div>
  );
}

/**
 * §3.2 and §8.2: this is the number that decides whether contact once stays on.
 * Below about 5% the policy is free. Above about 25% there is a real decision
 * to make, and it gets made with this number rather than a guess.
 */
function ContactedOnce({ stats }: { stats: HealthStats }) {
  const share = stats.contacted_other_campaign.share_of_matched;
  const band = share >= 0.25 ? 'decide' : share >= 0.05 ? 'watch' : 'free';
  const tone = band === 'decide' ? 'danger' : band === 'watch' ? 'warn' : 'signal';
  const verdict =
    band === 'decide'
      ? 'Above 25 percent. There is a genuine policy decision here, and this is the number to make it with.'
      : band === 'watch'
        ? 'Between 5 and 25 percent. Worth watching. Not yet worth changing the index.'
        : 'Below 5 percent. Contact once is close to free and stays as it is.';

  return (
    <Panel
      title="Contact once, the cost of it"
      note="§3.2 policy lever, enforced by sends_email_hash_uniq alone"
    >
      <div className="grid gap-6 py-2 lg:grid-cols-[minmax(0,0.7fr)_minmax(0,2fr)]">
        <Stat
          label="dropped as contacted_other_campaign"
          value={formatShare(share)}
          size="lg"
          tone={tone}
          sub={`${formatInt(stats.contacted_other_campaign.count)} leads, as a share of matched`}
        />
        <div className="flex flex-col gap-3">
          <div className="relative h-3 w-full bg-raised">
            <div
              className={cn(
                'absolute inset-y-0 left-0',
                tone === 'danger' ? 'bg-danger' : tone === 'warn' ? 'bg-warn' : 'bg-signal',
              )}
              style={{ width: `${Math.min(100, Math.max(0, share * 100 * 2)).toFixed(2)}%` }}
            />
            <div className="absolute inset-y-[-4px] left-[10%] w-px bg-edge-strong" />
            <div className="absolute inset-y-[-4px] left-1/2 w-px bg-edge-strong" />
          </div>
          <div className="flex justify-between font-mono text-[10px] tracking-[0.1em] text-faint">
            <span>0%</span>
            <span>5% free</span>
            <span>25% decide</span>
            <span>50%</span>
          </div>
          <p className="max-w-2xl text-xs leading-relaxed text-dim">{verdict}</p>
          <p className="max-w-2xl text-xs leading-relaxed text-faint">
            Relaxing this means replacing unique (email_hash) with unique (email_hash, campaign_id)
            and gating the second send on no reply, no click, a twelve month gap and still no
            suppression. Nothing else in the system changes.
          </p>
        </div>
      </div>
    </Panel>
  );
}

function DropReasons({ stats }: { stats: HealthStats }) {
  const rows = [...stats.drop_reasons].sort((a, b) => b.count - a.count);
  const max = rows.reduce((m, r) => Math.max(m, r.count), 0);

  return (
    <Panel title="Drop reasons" note="as a share of matched leads (§8.2)">
      {rows.length === 0 ? (
        <Empty
          headline="No leads have dropped yet."
          hint="Every lead that dies before send records why, and the reason is never overwritten."
        />
      ) : (
        <ul className="flex flex-col gap-3 py-2">
          {rows.map((r) => {
            const highlight = r.reason === 'contacted_other_campaign';
            return (
              <li key={r.reason} className="flex flex-col gap-1.5">
                <div className="flex items-baseline justify-between gap-4">
                  <span
                    className={cn(
                      'font-mono text-[12px]',
                      highlight ? 'text-warn' : 'text-dim',
                    )}
                  >
                    {r.reason}
                  </span>
                  <span className="font-mono text-[12px] tabular-nums text-faint">
                    {formatInt(r.count)}
                    <span className="ml-3 text-dim">{formatShare(r.share_of_matched)}</span>
                  </span>
                </div>
                <div className="h-1.5 w-full bg-raised">
                  <div
                    className={cn('h-full', highlight ? 'bg-warn' : 'bg-edge-strong')}
                    style={{ width: `${max > 0 ? ((r.count / max) * 100).toFixed(2) : 0}%` }}
                  />
                </div>
                <span className="text-[11px] text-faint">
                  {DROP_REASON_LABELS[r.reason as DropReason] ?? 'not a known reason'}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

function Jurisdiction({ stats }: { stats: HealthStats }) {
  const j = stats.jurisdiction;
  return (
    <Panel title="Jurisdiction gate" note="what US only costs (§9.1, §15.6)">
      <div className="flex flex-col gap-5 py-2">
        <div className="grid grid-cols-2 gap-6">
          <Stat
            label="blocked, share of swept"
            value={formatShare(j.share_blocked)}
            size="md"
            tone={j.share_blocked > 0.5 ? 'warn' : 'default'}
            sub={`${formatInt(j.blocked)} of ${formatInt(j.swept)} swept`}
          />
          <Stat
            label="swept and kept"
            value={formatInt(j.swept)}
            size="md"
            tone="quiet"
            sub="every lead is stored, contactable or not"
          />
        </div>

        <div>
          <span className="lbl">Top countries</span>
          {j.top_countries.length === 0 ? (
            <p className="mt-2 text-[12px] text-faint">Nothing resolved yet.</p>
          ) : (
            <ul className="mt-2 flex flex-wrap gap-2">
              {j.top_countries.map((c) => (
                <li key={c.country ?? 'unknown'}>
                  <Chip tone={c.country ? 'neutral' : 'warn'}>
                    {c.country ?? 'unknown'} {formatInt(c.count)}
                  </Chip>
                </li>
              ))}
            </ul>
          )}
        </div>

        <p className="max-w-prose text-xs leading-relaxed text-faint">
          Unknown counts as blocked, never benefit of the doubt: misclassifying a German or Danish
          founder as American is the expensive error. A high number here is pressure on the M7
          allowlist work and on the public reply channel, not a reason to relax the gate.
        </p>
      </div>
    </Panel>
  );
}

function Sources({ stats, timezone }: { stats: HealthStats; timezone: string }) {
  if (stats.sources.length === 0) {
    return (
      <Panel title="Sources">
        <Empty
          headline="No sources registered."
          hint="The worker upserts each source on boot. Show HN and Product Hunt carry the first two weeks on their own."
        />
      </Panel>
    );
  }
  return (
    <Panel title="Sources" note="failures are isolated, one broken scraper stops nothing else" bodyClassName="">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[52rem]">
          <thead>
            <tr>
              <TH>Source</TH>
              <TH>Kind</TH>
              <TH>Enabled</TH>
              <TH>Last swept</TH>
              <TH align="right">Age</TH>
              <TH>Last error</TH>
            </tr>
          </thead>
          <tbody>
            {stats.sources.map((s) => (
              <tr key={s.id} className="hover:bg-raised/60">
                <TD>
                  <span className="font-mono text-[13px] text-fg">{s.id}</span>
                  <div className="text-[11px] text-faint">{s.name}</div>
                </TD>
                <TD mono>{s.kind}</TD>
                <TD>
                  {s.enabled ? <Chip tone="signal">on</Chip> : <Chip tone="ghost">off</Chip>}
                </TD>
                <TD mono>{s.last_swept_at ? formatDateTime(s.last_swept_at, timezone) : 'never'}</TD>
                <TD mono align="right">
                  {relativeAge(s.last_swept_at)}
                </TD>
                <TD>
                  {s.last_error ? (
                    <span className="font-mono text-[11px] text-danger">{s.last_error}</span>
                  ) : (
                    <span className="text-[11px] text-faint">clean</span>
                  )}
                </TD>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}
