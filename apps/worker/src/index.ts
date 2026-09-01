// The systemd entry point (§4, §8).
//
// Seed the campaigns from probe.toml, register the morning cron schedule, then
// hand the process to the send daemon. Everything here is either a schedule or
// a shutdown detail; the work itself lives in jobs/.

import cron, { type ScheduledTask } from 'node-cron';
import { assertSendReady, loadConfig, logger, publicBaseUrl } from '@probe/config';
import { closeSql, reconcileStuckSends } from '@probe/db';
import { runSeed } from './jobs/seed';
import { runSweep } from './jobs/sweep';
import { runResolve } from './jobs/resolve';
import { runGenerate } from './jobs/generate';
import { runAutoPause } from './jobs/autopause';
import { runSendDaemon, type SendDaemonHandle } from './jobs/send';
import { sendEnabled } from './send/runtime';

const log = logger('worker');

/** One run of a named job at a time. The 07:30 generate pass and the ten
 *  minute re-poll share a schedule window, and two passes racing over the same
 *  pending proofs would double the generator calls for no benefit. */
const running = new Set<string>();

async function runExclusive(name: string, fn: () => Promise<unknown>): Promise<void> {
  if (running.has(name)) {
    log.warn('skipping a scheduled run, the previous one is still going', { job: name });
    return;
  }
  running.add(name);
  const started = Date.now();
  try {
    const summary = await fn();
    log.info('job finished', { job: name, ms: Date.now() - started, summary });
  } catch (err) {
    // A failing job must never take the process down. systemd restarting the
    // worker at 07:00 would only lose the send daemon's place in the queue.
    log.error('job threw', {
      job: name,
      ms: Date.now() - started,
      error: err instanceof Error ? (err.stack ?? err.message) : String(err),
    });
  } finally {
    running.delete(name);
  }
}

function banner(): void {
  const cfg = loadConfig();
  const enabled = sendEnabled();
  // The single fact that decides whether this process can email a stranger.
  // Printed at error level when live, so it is impossible to miss in a log
  // that is otherwise all info.
  const fields = {
    send_enabled: enabled,
    campaigns: cfg.campaigns.map((c) => c.slug),
    allowed_countries: cfg.global.allowed_countries,
    send_days: cfg.global.send_days,
    send_window: cfg.global.send_window,
    timezone: cfg.global.timezone,
    // Logged because it is the field whose wrongness is invisible in the
    // rendered email: a base url pointing at localhost produces an unsubscribe
    // link the recipient cannot reach, and nothing else would ever mention it.
    public_base_url: (() => {
      try {
        return publicBaseUrl();
      } catch {
        return 'unreadable';
      }
    })(),
    postal_address: cfg.global.postal_address,
  };
  if (enabled) {
    log.warn('probe worker starting: SENDING IS ENABLED, real mail will leave this host', fields);
  } else {
    log.info('probe worker starting: dry run, PROBE_SEND_ENABLED is not true', fields);
  }
}

export async function main(): Promise<void> {
  banner();

  // Refuse to start live with a configuration that would produce broken mail.
  // Deliberately a hard failure and not a warning: the failure modes it catches
  // (no Day3 key, no webhook secret, a localhost base url, a placeholder postal
  // address) all produce email that looks fine in the log and is broken in the
  // recipient's inbox. In dry-run this does nothing, so the M0 harness still
  // runs on a laptop with almost no environment.
  if (sendEnabled()) assertSendReady();

  const cfg = loadConfig();
  const timezone = cfg.global.timezone;

  // A row left in 'sending' means a previous process died between claiming a
  // send and hearing back from the provider. It holds a contact-once slot and
  // will never be dispatched, so it has to be resolved before the daemon
  // starts. Resolved to 'failed', never re-queued: the message may already have
  // gone out, and a founder getting the same probe report twice is the mistake
  // that would actually embarrass us (§7).
  const stuck = await reconcileStuckSends();
  if (stuck.length > 0) {
    log.error('resolved sends left mid-dispatch by a previous process', {
      count: stuck.length,
      sendIds: stuck.map((s) => s.id),
      note: 'each is marked failed; its proof returns to /queue for re-approval',
    });
  }

  // §11. probe.toml seeds, the database rules. Never touches paused or
  // warmup_start, so a deploy cannot unpause a campaign.
  await runSeed();

  const tasks: ScheduledTask[] = [];
  const every = (expression: string, name: string, fn: () => Promise<unknown>): void => {
    tasks.push(
      cron.schedule(expression, () => void runExclusive(name, fn), { timezone, scheduled: true }),
    );
    log.info('scheduled', { job: name, cron: expression, timezone });
  };

  every('30 6 * * *', 'sweep', runSweep);
  every('0 7 * * *', 'resolve', runResolve);
  every('30 7 * * *', 'generate', runGenerate);
  // The generator answers 202 and works for 60 to 90 minutes (§6), so one pass
  // at 07:30 would leave every pending proof unpolled until tomorrow. Re-poll
  // through the morning; duePendingProofs and next_poll_at decide what is
  // actually due, so an extra tick costs one query.
  every('*/10 8-11 * * *', 'generate-repoll', runGenerate);
  every('0 * * * *', 'autopause', runAutoPause);

  const daemon: SendDaemonHandle = await runSendDaemon();

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('shutting down', { signal });

    // Stop the schedules first so nothing new starts, then let the daemon
    // finish the send it may be in the middle of. Stopping mid-dispatch is the
    // one way to lose track of whether an email went out.
    for (const task of tasks) task.stop();

    daemon.stop();
    void daemon.stopped
      .then(() => closeSql())
      .catch((err: unknown) => {
        log.error('shutdown error', { error: err instanceof Error ? err.message : String(err) });
      })
      .finally(() => {
        log.info('stopped');
        process.exit(0);
      });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  await daemon.stopped;
}

if (require.main === module) {
  main().catch((err: unknown) => {
    log.error('worker failed to start', {
      error: err instanceof Error ? (err.stack ?? err.message) : String(err),
    });
    process.exit(1);
  });
}
