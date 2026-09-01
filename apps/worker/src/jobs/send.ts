// The send daemon (§8.6) and its one-shot twin.
//
// runSendDaemon is what systemd starts. sendOnce is what the CLI runs and what
// a test drives: exactly one iteration per campaign, then a summary. Both go
// through the same sendIteration, so there is no "test path" that skips a gate.

import { listCampaigns } from '@probe/db';
import { logger } from '@probe/config';
import {
  groupBySendingDomain,
  runPacingLoop,
  sendIteration,
  type IterationOutcome,
} from '../send/pacing-loop';
import { createSender } from '../send/sender';
import { sendEnabled } from '../send/runtime';
import type { SendSummary } from '../types';

const log = logger('job.send');

/** One iteration for every campaign. Consumes at most one queued send each. */
export async function sendOnce(): Promise<SendSummary> {
  const campaigns = await listCampaigns();
  const sender = createSender();

  const summary: SendSummary = { attempted: 0, sent: 0, skipped: 0, failed: 0 };
  const reasons: string[] = [];

  for (const campaign of campaigns) {
    const outcome = await sendIteration({ campaignId: campaign.id, sender });
    reasons.push(`${campaign.slug}:${outcome.kind}`);
    tally(summary, outcome);
  }

  summary.reason = reasons.join(' ');
  log.info('send once complete', { ...summary });
  return summary;
}

function tally(summary: SendSummary, outcome: IterationOutcome): void {
  switch (outcome.kind) {
    case 'sent':
      summary.attempted += 1;
      summary.sent += 1;
      break;
    case 'failed':
    case 'lint_failed':
      summary.attempted += 1;
      summary.failed += 1;
      break;
    case 'cancelled':
      summary.attempted += 1;
      summary.skipped += 1;
      break;
    default:
      // disabled, paused, out of window, cap reached, idle, missing campaign.
      // Nothing was claimed, so nothing was attempted.
      summary.skipped += 1;
  }
}

export interface SendDaemonHandle {
  /** Resolves once every loop has finished its current iteration and exited. */
  stopped: Promise<void>;
  stop(): void;
}

/**
 * Starts one pacing loop per sending subdomain and returns a handle. SIGINT
 * and SIGTERM are wired to stop(), so systemd stops the daemon between sends
 * rather than mid-dispatch: the abort is only observed between iterations and
 * inside a sleep, never while SES has a request in flight.
 */
export async function runSendDaemon(): Promise<SendDaemonHandle> {
  const campaigns = await listCampaigns();
  const groups = groupBySendingDomain(campaigns);
  const sender = createSender();
  const controller = new AbortController();

  log.info('send daemon starting', {
    send_enabled: sendEnabled(),
    subdomains: [...groups.keys()],
    campaigns: campaigns.length,
  });

  const loops = [...groups.entries()].map(([domain, group]) =>
    runPacingLoop({
      domain,
      campaignIds: group.map((c) => c.id),
      sender,
      signal: controller.signal,
    }),
  );

  const stopped = Promise.all(loops).then(() => {
    log.info('send daemon stopped');
  });

  const stop = (): void => {
    if (!controller.signal.aborted) {
      log.info('send daemon stopping, letting the in flight send finish');
      controller.abort();
    }
  };

  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  return { stopped, stop };
}
