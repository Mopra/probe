// The systemd entry point (§4, §8).
//
// Seed the campaigns from probe.toml, register the morning cron schedule, then
// hand the process to the send daemon. Everything here is either a schedule or
// a shutdown detail; the work itself lives in jobs/.

import cron, { type ScheduledTask } from 'node-cron';
import { assertSendReady, loadConfig, logger, publicBaseUrl, type Weekday } from '@probe/config';
import { closeSql, reconcileStuckSends } from '@probe/db';
import { runSeed } from './jobs/seed';
import { runSweep } from './jobs/sweep';
import { runResolve } from './jobs/resolve';
import { runGenerate } from './jobs/generate';
import { runAutoApprove } from './jobs/approve';
import { runAutoPause } from './jobs/autopause';
import { runSendDaemon, type SendDaemonHandle } from './jobs/send';
import { sendEnabled } from './send/runtime';

const log = logger('worker');

/** One run of a named job at a time. The 07:30 generate pass and the ten
 *  minute re-poll share a schedule window, and two passes racing over the same
 *  pending proofs would double the generator calls for no benefit. */
const running = new Set<string>();

/** cron's own day numbering, 0 = Sunday. */
const CRON_DAY: Record<Weekday, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

/**
 * The day field for every schedule that only matters on a day probe can send.
 *
 * Derived from send_days rather than written out as `1-5`, so a config that
 * adds Saturday gets Saturday's generation too and there is one place that
 * decides which days probe is awake at all.
 */
export function cronDays(days: readonly Weekday[]): string {
  const numbers = [...new Set(days.map((d) => CRON_DAY[d]))].sort((a, b) => a - b);
  // Defensive: schema.ts requires at least one, and an empty field would make
  // node-cron reject the whole expression rather than run on no days.
  return numbers.length > 0 ? numbers.join(',') : '*';
}

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
    blocked_countries: cfg.global.blocked_countries,
    send_days: cfg.global.send_days,
    // §8.5. Whether anything reaches the send queue without a human reading it.
    auto_approve: cfg.global.auto_approve,
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

  // Which days probe does anything beyond collecting leads, and the hour it
  // stops. Both exist for one reason: Postgres is Neon, whose free allowance is
  // compute-hours, and whose compute suspends itself after five idle minutes
  // and wakes on the next query. A schedule that ticks every ten minutes from
  // 06:00 to 23:00, seven days a week, means the database is never idle for
  // five consecutive minutes and is therefore billed for all 730 hours in the
  // month against an allowance of 100. Nothing below changes what probe does on
  // a working morning; it changes the hours in which probe is awake at all.
  const days = cronDays(cfg.global.send_days);
  // 18:00, not 23:00. Be clear about what this gives up: a pass at 17:50 that
  // gets a 202 back is polled for ten minutes and then not again until 06:00,
  // by which time its two hour budget has expired and the proof is marked
  // failed. That shape needs an asynchronous generator, and neither of probe's
  // is one -- exit1's answers in seconds -- so today the cost is nothing, and
  // covering it would mean holding the database awake for five more hours
  // every single day. If a generator ever does start answering 202, this is
  // the line to raise, and the thing to raise it to is the send window's end
  // plus generator_budget_ms.
  const LAST_HOUR = 18;

  // Sweeping stays daily, weekend included. A Saturday launch is swept on
  // Saturday or not at all, the run is one burst rather than a beat, and the
  // leads simply wait for Monday's generate pass.
  every('30 6 * * *', 'sweep', runSweep);
  every('0 7 * * *', 'resolve', runResolve);
  every(`30 7 * * ${days}`, 'generate', runGenerate);
  // §6 allows a generator to answer 202 and be polled, so one pass at 07:30
  // would leave anything unfinished unpolled until tomorrow. exit1's generator
  // is synchronous and answers in seconds, so today this mostly re-polls calls
  // that errored and are backing off; the contract still allows the other shape
  // and this is what makes it work. duePendingProofs and next_poll_at decide
  // what is actually due, so an extra tick costs one query.
  //
  // The window used to be 8-11, matched to a 07:30 start. That silently
  // discarded any work started outside it: the two hour budget keeps running
  // whether or not anything is polling, so a generate run at 13:00 expired
  // unattended and every proof in it was marked failed the next morning. The
  // budget is a limit on the generator, not on the operator's working hours.
  // It is not a licence to poll all night either, which is what 6-23 daily
  // became: a run cannot start after the last tick, so polling past the hour
  // the ticks stop only ever finds an empty queue.
  every(`*/10 6-${LAST_HOUR} * * ${days}`, 'generate-repoll', runGenerate);

  // §8.5. Only does anything when auto_approve is true in probe.toml; the job
  // reads the flag itself rather than being conditionally scheduled, so the
  // answer to "is this running" is one line in the config and not a boot-time
  // branch nobody can see afterwards.
  //
  // Offset five minutes off the generate ticks so a pass reads proofs that the
  // generate run before it finished writing, rather than racing it for the
  // same rows. runExclusive only serialises a job against itself.
  if (cfg.global.auto_approve) {
    log.warn('AUTO-APPROVE IS ON: ready proofs become scheduled sends with no human read', {
      note: 'probe.toml [global] auto_approve. Pausing, warmup and PROBE_SEND_ENABLED still gate dispatch',
    });
  }
  every(`5-55/10 6-${LAST_HOUR} * * ${days}`, 'approve', runAutoApprove);

  // Hourly, but only on the days and hours something can actually be sent. The
  // check reads a seven day rolling window, so running it at 04:00 on a Sunday
  // asks a question whose answer cannot have changed since Friday and cannot
  // matter before Monday. A bounce that arrives overnight is still acted on
  // before the first send of the next morning, which is the only deadline it
  // has.
  every(`0 6-${LAST_HOUR} * * ${days}`, 'autopause', runAutoPause);

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
