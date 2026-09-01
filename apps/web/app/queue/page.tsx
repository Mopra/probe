import { listQueue } from '@probe/db';
import type { QueueItem } from '@probe/db';
import type { LintResult } from '@probe/core';
import { approveProof, rejectProof } from './actions';
import { QueueKeys } from './keys';
import { cn, formatDateTime, metaEntries, relativeAge } from '../lib/format';
import { operatorTimezone } from '../lib/probe';
import { renderProof } from '../lib/render';
import type { RenderedProof } from '../lib/render';
import { Button, Chip, Empty, Field, LinkButton } from '../lib/ui';

export const dynamic = 'force-dynamic';

interface Search {
  notice?: string;
  detail?: string;
}

export default async function QueuePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const search: Search = {
    notice: first(sp.notice),
    detail: first(sp.detail),
  };

  const timezone = operatorTimezone();
  const items = await listQueue();
  const rendered = items.map((item) => renderProof(item));
  const failing = rendered.filter((r) => !r.lint.ok).length;

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-wrap items-end justify-between gap-4 border-b border-edge pb-4">
        <div className="flex flex-col gap-1">
          <span className="lbl">Approval surface</span>
          <h1 className="text-2xl font-light tracking-tight">Queue</h1>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Chip tone={items.length > 0 ? 'signal' : 'neutral'}>
            {items.length} awaiting approval
          </Chip>
          {failing > 0 && <Chip tone="danger">{failing} failing lint</Chip>}
          <span className="font-mono text-[11px] text-faint">
            nothing here has been scheduled
          </span>
        </div>
      </header>

      {search.notice && <Notice code={search.notice} detail={search.detail} timezone={timezone} />}

      <QueueKeys count={items.length} />

      {items.length === 0 ? (
        <Empty
          headline="Nothing to approve."
          hint="Items land here when the generate job returns a severity 1 finding for a matched lead with a resolved contact. A generator that finds nothing drops the lead as no_proof, which is the expected majority outcome."
        />
      ) : (
        <div className="flex flex-col gap-6">
          {items.map((item, index) => (
            <QueueRow
              key={item.proof.id}
              index={index}
              item={item}
              rendered={rendered[index]!}
              timezone={timezone}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

function QueueRow({
  index,
  item,
  rendered,
  timezone,
}: {
  index: number;
  item: QueueItem;
  rendered: RenderedProof;
  timezone: string;
}) {
  const { lead, campaign, contact, proof } = item;
  const lintOk = rendered.lint.ok;

  return (
    <article
      id={`q-${index}`}
      data-queue-item={index}
      data-lint={lintOk ? 'pass' : 'fail'}
      className="scroll-mt-24 border border-edge bg-surface"
    >
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-edge px-4 py-3">
        <span className="font-mono text-[11px] tabular-nums text-faint">
          {String(index + 1).padStart(2, '0')}
        </span>
        <h2 className="text-base font-normal tracking-tight text-fg">{lead.name}</h2>
        <span className="font-mono text-[12px] text-dim">{lead.domain}</span>
        <Chip>{campaign.slug}</Chip>
        <Chip tone={proof.severity === 1 ? 'signal' : 'warn'}>
          severity {proof.severity ?? '?'}
        </Chip>
        {lintOk ? (
          <Chip tone="signal">lint pass</Chip>
        ) : (
          <Chip tone="danger">lint fail: {rendered.lint.violations.length}</Chip>
        )}
        <span className="font-mono text-[11px] text-faint">
          ready {relativeAge(proof.ready_at ?? proof.created_at)}
        </span>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <form action={approveProof} data-action="approve">
            <input type="hidden" name="proof_id" value={proof.id} />
            <Button
              tone="signal"
              disabled={!lintOk}
              title={
                lintOk
                  ? 'Writes the sends row and schedules it. Key: a'
                  : 'The copy lint fails. A failing email cannot be approved (§8.5).'
              }
            >
              Approve
            </Button>
          </form>
          <form action={rejectProof} data-action="reject">
            <input type="hidden" name="proof_id" value={proof.id} />
            <Button tone="danger" title="Sets the lead to rejected. Key: x">
              Reject
            </Button>
          </form>
          <LinkButton href={`/queue/${proof.id}/eml`} target="_blank">
            View raw .eml
          </LinkButton>
        </div>
      </header>

      <div className="grid gap-px bg-edge lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
        <div className="bg-surface">
          <div className="flex items-baseline justify-between gap-3 border-b border-edge px-4 py-2.5">
            <span className="lbl">Subject</span>
            <span className="font-mono text-[11px] text-faint">
              rendered html, sandboxed, scripts blocked
            </span>
          </div>
          <p className="border-b border-edge px-4 py-3 font-mono text-[13px] leading-relaxed text-fg">
            {rendered.subject || <span className="text-danger">no subject on this proof</span>}
          </p>
          <div className="bg-white">
            <iframe
              title={`Rendered email for ${lead.name}`}
              srcDoc={rendered.html}
              sandbox=""
              referrerPolicy="no-referrer"
              className="h-[38rem] w-full border-0 bg-white"
            />
          </div>
        </div>

        <div className="flex flex-col bg-surface">
          <Lint result={rendered.lint} />

          <div className="px-4 py-1">
            <Field label="Product">{lead.name}</Field>
            <Field label="URL" mono>
              <a
                href={lead.url}
                target="_blank"
                rel="noreferrer"
                className="text-signal underline underline-offset-2"
              >
                {lead.url}
              </a>
            </Field>
            <Field label="Source" mono>
              {lead.source_id}
              <span className="ml-2 text-faint">{lead.external_id}</span>
            </Field>
            <Field label="Description">
              {lead.description ?? <span className="text-faint">none recorded</span>}
            </Field>
            <Field label="Tags">
              {lead.tags.length > 0 ? (
                <span className="flex flex-wrap gap-1">
                  {lead.tags.map((t) => (
                    <Chip key={t} tone="ghost">
                      {t}
                    </Chip>
                  ))}
                </span>
              ) : (
                <span className="text-faint">none</span>
              )}
            </Field>
            <Field label="Jurisdiction" mono>
              <span className={lead.jurisdiction ? 'text-fg' : 'text-warn'}>
                {lead.jurisdiction ?? 'unknown'}
              </span>
              <span className="ml-2 text-faint">
                via {lead.jurisdiction_source ?? 'none'}
              </span>
              {lead.jurisdiction_detail && (
                <div className="mt-1 text-[11px] text-faint">{lead.jurisdiction_detail}</div>
              )}
            </Field>
            <Field label="Contact" mono>
              <span className="text-fg">{contact.email ?? 'scrubbed'}</span>
              <div className="mt-1 text-[11px] text-faint">
                found by {contact.method}, confidence {contact.confidence}, {formatDateTime(contact.found_at, timezone)}
              </div>
            </Field>
            <Field label="Severity" mono>
              {proof.severity ?? '?'}
            </Field>
            <Field label="Evidence" mono>
              {proof.evidence_url ? (
                <a
                  href={proof.evidence_url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-signal underline underline-offset-2 break-all"
                >
                  {proof.evidence_url}
                </a>
              ) : (
                <span className="text-warn">none on this proof</span>
              )}
              <div className="mt-1 break-all text-[11px] text-faint">
                sends as {rendered.links.click}
              </div>
            </Field>
            <Field label="Fix">
              {proof.fix ? (
                <span className="whitespace-pre-wrap">{proof.fix}</span>
              ) : (
                <span className="text-danger">missing, and the fix is required (§6)</span>
              )}
            </Field>
          </div>

          <Meta meta={proof.meta} />
        </div>
      </div>
    </article>
  );
}

function Lint({ result }: { result: LintResult }) {
  if (result.ok) {
    return (
      <div className="flex items-center gap-3 border-b border-edge bg-signal-dim/10 px-4 py-2.5">
        <span className="lbl">Copy lint</span>
        <span className="font-mono text-[12px] text-signal">
          pass, all §9.2 checks clear
        </span>
      </div>
    );
  }
  return (
    <div className="border-b border-edge bg-danger-dim/10 px-4 py-2.5">
      <div className="flex items-center gap-3">
        <span className="lbl">Copy lint</span>
        <span className="font-mono text-[12px] text-danger">
          fail, {result.violations.length} violation{result.violations.length === 1 ? '' : 's'},
          approval is blocked
        </span>
      </div>
      <ul className="mt-2 flex flex-col gap-1.5">
        {result.violations.map((v, i) => (
          <li key={`${v.code}-${i}`} className="flex gap-2 text-[12px] leading-snug">
            <span className="shrink-0 font-mono text-[11px] uppercase tracking-[0.1em] text-danger">
              {v.code}
            </span>
            <span className="text-dim">
              {v.message}
              <span className="ml-1 text-faint">[{v.where}]</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Meta({ meta }: { meta: Record<string, unknown> }) {
  const entries = metaEntries(meta);
  return (
    <div className="mt-auto border-t border-edge px-4 py-3">
      <span className="lbl">Generator meta</span>
      {entries.length === 0 ? (
        <p className="mt-2 text-[12px] text-faint">empty</p>
      ) : (
        <dl className="mt-2 grid grid-cols-[minmax(0,10rem)_minmax(0,1fr)] gap-x-3 gap-y-1">
          {entries.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="truncate font-mono text-[11px] text-faint">{k}</dt>
              <dd className="whitespace-pre-wrap break-words font-mono text-[11px] tabular-nums text-dim">
                {v}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

function Notice({
  code,
  detail,
  timezone,
}: {
  code: string;
  detail?: string;
  timezone: string;
}) {
  const map: Record<string, { tone: 'signal' | 'warn' | 'danger'; text: string }> = {
    approved: {
      tone: 'signal',
      text: detail
        ? `Approved. Scheduled for ${formatDateTime(detail, timezone)}.`
        : 'Approved and scheduled.',
    },
    approved_no_capacity: {
      tone: 'warn',
      text: detail
        ? `Approved and queued for ${formatDateTime(detail, timezone)}, but that day has no warmup capacity left. The send daemon will hold it until a day with room. Check the campaign warmup start.`
        : 'Approved, but no day inside the horizon had warmup capacity left.',
    },
    rejected: {
      tone: 'warn',
      text: detail ? `Rejected ${detail}. The lead is marked rejected.` : 'Rejected.',
    },
    lint_failed: {
      tone: 'danger',
      text: `The copy lint failed at approval, so nothing was scheduled. ${detail ?? ''} violations are listed on the item below.`.trim(),
    },
    suppressed: {
      tone: 'warn',
      text: detail
        ? `${detail} was suppressed between generation and approval. Lead dropped as suppressed. Nothing was scheduled.`
        : 'That address is suppressed. Lead dropped, nothing was scheduled.',
    },
    contacted: {
      tone: 'warn',
      text: detail
        ? `Already contacted, ${detail} dropped as contacted_other_campaign. This is §3.2 doing its job, and it is counted on /health.`
        : 'Already contacted, lead dropped as contacted_other_campaign.',
    },
    missing: {
      tone: 'danger',
      text: 'That proof is no longer in the queue. It may have been approved or rejected in another tab.',
    },
  };
  const notice = map[code];
  if (!notice) return null;
  const toneClass =
    notice.tone === 'signal'
      ? 'border-signal-dim bg-signal-dim/15 text-signal'
      : notice.tone === 'warn'
        ? 'border-warn-dim bg-warn-dim/15 text-warn'
        : 'border-danger-dim bg-danger-dim/15 text-danger';
  return (
    <div className={cn('flex items-start gap-3 border px-4 py-3 text-sm', toneClass)}>
      <span className="lbl pt-0.5">Result</span>
      <p className="leading-relaxed">{notice.text}</p>
    </div>
  );
}
