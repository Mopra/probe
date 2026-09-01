#!/usr/bin/env node
// The operator entry point.
//
// Every job is runnable one-shot, which exists so nobody ever debugs the
// pipeline by waiting for 06:30. Printing to the operator is the output here,
// so console is the interface; everything the jobs themselves log still goes
// through the structured logger.
//
// Each command is imported dynamically so `cli dry-run` loads neither the
// database package nor the AWS SDK. The M0 deliverable has to work on a laptop
// with no .env and no network (§13).

const COMMANDS = [
  'sweep',
  'resolve',
  'generate',
  'send',
  'seed',
  'autopause',
  'dry-run',
  'health',
  'preflight',
  'warmup',
  'hash',
  'erase',
  'stuck',
] as const;

type Command = (typeof COMMANDS)[number];

interface Flags {
  fromDb: boolean;
  out?: string;
  limit?: number;
  yes: boolean;
  /** Bare arguments, in order: `warmup exit1 2026-09-08` -> ['exit1', '...']. */
  positional: string[];
}

function parseFlags(argv: string[]): Flags {
  const flags: Flags = { fromDb: false, yes: false, positional: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--from-db') flags.fromDb = true;
    else if (arg === '--yes' || arg === '-y') flags.yes = true;
    else if (arg === '--out') flags.out = argv[++i];
    else if (arg === '--limit') flags.limit = Number(argv[++i]);
    else if (arg.startsWith('--out=')) flags.out = arg.slice('--out='.length);
    else if (arg.startsWith('--limit=')) flags.limit = Number(arg.slice('--limit='.length));
    else if (!arg.startsWith('-')) flags.positional.push(arg);
  }
  return flags;
}

function usage(): void {
  console.log('usage: cli <command> [flags]');
  console.log('');
  console.log('  sweep      run the launch directory sweep once (§8.1)');
  console.log('  resolve    run jurisdiction, match and contact resolution once (§8.2, §8.3)');
  console.log('  generate   start and poll generator work once (§8.4)');
  console.log('  send       one send iteration per campaign (§8.6)');
  console.log('  seed       upsert campaigns from probe.toml (§11)');
  console.log('  autopause  check rolling bounce and complaint rates (§5.5)');
  console.log('  dry-run    render .eml files and lint them (§13 M0)');
  console.log('  health     print source, generator, rate and drop numbers (§10)');
  console.log('');
  console.log('  preflight  check everything that must be true before real mail can leave');
  console.log('  warmup     start the warmup curve for a campaign (§5.4). Without this the');
  console.log('             daily cap is 0 and NOTHING sends. `warmup exit1 [YYYY-MM-DD]`');
  console.log('  stuck      list or resolve sends left mid-dispatch by a crashed worker');
  console.log('  hash       peppered hash of an address, for a GDPR request (§9.3)');
  console.log('  erase      GDPR erasure by address or hash: `erase a@b.com --yes`');
  console.log('');
  console.log('flags:');
  console.log('  --from-db        dry-run only: render every ready proof instead of fixtures');
  console.log('  --out <dir>      dry-run only: where to write .eml files');
  console.log('  --limit <n>      dry-run and health: cap the rows read');
  console.log('  --yes            erase and stuck: actually do it, rather than showing what would happen');
}

/** Set by every command that opens a database connection, so the pool is only
 *  closed when one exists. dry-run never loads @probe/db and must not start
 *  loading it just to shut it down. */
let usedDatabase = false;

function isCommand(value: string | undefined): value is Command {
  return value !== undefined && (COMMANDS as readonly string[]).includes(value);
}

async function main(): Promise<number> {
  const [, , raw, ...rest] = process.argv;

  if (!isCommand(raw)) {
    if (raw !== undefined && raw !== '--help' && raw !== '-h' && raw !== 'help') {
      console.error(`unknown command: ${raw}`);
      usage();
      return 2;
    }
    usage();
    return 0;
  }

  const command: Command = raw;
  const flags = parseFlags(rest);
  usedDatabase = command !== 'dry-run' || flags.fromDb;

  switch (command) {
    case 'dry-run': {
      const { runDryRun } = await import('./harness/dry-run');
      const result = await runDryRun({
        fromDb: flags.fromDb,
        outDir: flags.out,
        limit: flags.limit,
      });
      // Non-zero when a fixture that is supposed to pass did not, so the
      // harness works in CI as a regression test on the lint and the footer.
      return result.unexpected > 0 ? 1 : 0;
    }

    case 'seed': {
      const { runSeed } = await import('./jobs/seed');
      const summary = await runSeed();
      console.log(`seeded ${summary.campaigns} campaigns: ${summary.slugs.join(', ')}`);
      console.log('campaigns are born paused; the seed never touches paused or warmup_start');
      return 0;
    }

    case 'sweep': {
      const { runSweep } = await import('./jobs/sweep');
      const s = await runSweep();
      console.log(`swept ${s.swept}  inserted ${s.inserted}  duplicates ${s.duplicates}`);
      for (const e of s.errors) console.error(`  source ${e.source}: ${e.error}`);
      return s.inserted === 0 && s.errors.length > 0 ? 1 : 0;
    }

    case 'preflight': {
      // The single command to run before flipping PROBE_SEND_ENABLED. Everything
      // it checks is something whose absence produces a silently broken email
      // rather than a visible error, which is why it is a command and not a
      // paragraph in the runbook.
      const { sendPreflight, loadConfig, publicBaseUrl } = await import('@probe/config');
      const { sendEnabled } = await import('./send/runtime');
      const cfg = loadConfig();

      console.log('probe preflight');
      console.log('');
      console.log(`  PROBE_SEND_ENABLED   ${sendEnabled() ? 'true  (LIVE)' : 'false (dry run)'}`);
      console.log(`  public base url      ${safe(() => publicBaseUrl())}`);
      console.log(`  postal address       ${cfg.global.postal_address}`);
      console.log(`  allowed countries    ${cfg.global.allowed_countries.join(', ')}`);
      console.log(`  campaigns            ${cfg.campaigns.map((c) => c.slug).join(', ')}`);
      console.log('');

      const problems = sendPreflight();
      if (problems.length === 0) {
        console.log('  everything required for a real send is in place.');
      } else {
        console.log(`  ${problems.length} problem${problems.length === 1 ? '' : 's'}:`);
        for (const p of problems) console.log(`    ${p.key}: ${p.problem}`);
      }
      console.log('');

      // The database half: warmup, pausing, and anything stuck. Reported as
      // unavailable rather than fatal when there is no database, so preflight
      // still tells you something useful on a laptop.
      try {
        const { listCampaigns, stuckSendingSends } = await import('@probe/db');
        const campaigns = await listCampaigns();
        console.log('  campaign state');
        for (const c of campaigns) {
          const warmup = c.warmup_start
            ? `warmup from ${String(c.warmup_start).slice(0, 10)}`
            : 'WARMUP NOT STARTED: daily cap is 0, nothing will send';
          console.log(`    ${c.slug.padEnd(10)} ${c.paused ? 'paused' : 'live  '}  ${warmup}`);
        }
        const stuck = await stuckSendingSends();
        if (stuck.length > 0) {
          console.log('');
          console.log(`  ${stuck.length} send(s) stuck mid-dispatch. Run: cli stuck`);
        }
      } catch (err) {
        console.log(`  campaign state       unavailable (${describe(err)})`);
      }

      return problems.length > 0 ? 1 : 0;
    }

    case 'warmup': {
      // §5.4. Without warmup_start, dailyCap() returns 0 for every day, gate 4
      // of the send loop reports cap_reached forever, and not one email leaves.
      // The runbook told the operator to set this and there was no way to.
      const { getCampaignBySlug, startWarmup, listCampaigns } = await import('@probe/db');
      const slug = flags.positional[0];
      if (!slug) {
        const campaigns = await listCampaigns();
        console.error('usage: cli warmup <slug> [YYYY-MM-DD]');
        console.error('');
        console.error('campaigns:');
        for (const c of campaigns) {
          const state = c.warmup_start
            ? `warmup from ${String(c.warmup_start).slice(0, 10)}`
            : 'not started';
          console.error(`  ${c.slug.padEnd(10)} ${state}`);
        }
        return 2;
      }

      const campaign = await getCampaignBySlug(slug);
      if (!campaign) {
        console.error(`no campaign with slug "${slug}"`);
        return 1;
      }

      const day = flags.positional[1] ?? todayIn(campaign.timezone);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
        console.error(`"${day}" is not a date in YYYY-MM-DD form`);
        return 2;
      }

      if (campaign.warmup_start && !flags.yes) {
        // Re-dating warmup backwards raises today's cap, which is the one edit
        // here that can increase how much mail goes out. Never silent.
        console.error(
          `${slug} already started warmup on ${String(campaign.warmup_start).slice(0, 10)}. ` +
            `Re-dating it to ${day} changes today's cap. Pass --yes if that is what you mean.`,
        );
        return 1;
      }

      await startWarmup(campaign.id, day);
      console.log(`${slug}: warmup day 1 is ${day}`);
      console.log('curve: days 1-3 cap 5, 4-7 cap 10, 8-14 cap 20, 15-21 cap 35, 22+ cap 50');
      console.log(
        `the campaign is still ${campaign.paused ? 'PAUSED' : 'live'}; warmup does not unpause it`,
      );
      return 0;
    }

    case 'stuck': {
      // A row in 'sending' means a worker died between claiming the send and
      // hearing back from the provider. Whether the message went out is
      // genuinely unknown, so this reports before it resolves anything.
      const { stuckSendingSends, reconcileStuckSends } = await import('@probe/db');
      const rows = await stuckSendingSends();
      if (rows.length === 0) {
        console.log('no sends are stuck mid-dispatch.');
        return 0;
      }
      console.log(`${rows.length} send(s) left mid-dispatch:`);
      for (const r of rows) {
        console.log(
          `  ${r.id}  scheduled ${r.scheduled_for.toISOString()}  campaign ${r.campaign_id}`,
        );
      }
      if (!flags.yes) {
        console.log('');
        console.log('Whether the provider accepted these is unknown. Resolving them marks each');
        console.log('one failed, which releases its contact-once slot and returns its proof to');
        console.log('/queue for a deliberate re-approval. Nothing is ever re-sent automatically.');
        console.log('Look these send ids up in the Day3 dashboard first, then pass --yes.');
        return 1;
      }
      const resolved = await reconcileStuckSends();
      console.log(`resolved ${resolved.length} send(s) to failed.`);
      return 0;
    }

    case 'hash': {
      // §9.3. Turning an address into its peppered hash is the first step of
      // every GDPR request, and there was no way to do it without a REPL.
      const { hashEmail, normalizeEmail } = await import('@probe/core');
      const { loadEnv } = await import('@probe/config');
      const raw = flags.positional[0];
      if (!raw) {
        console.error('usage: cli hash <email>');
        return 2;
      }
      const norm = normalizeEmail(raw);
      if (!norm) {
        console.error(`"${raw}" is not a usable email address`);
        return 1;
      }
      console.log(`normalized  ${norm}`);
      console.log(`hash        ${hashEmail(norm, loadEnv().PROBE_HASH_PEPPER)}`);
      return 0;
    }

    case 'erase': {
      // §9.3 erasure. Takes an address or a hash; an address is normalized and
      // hashed here so nobody has to do that by hand under time pressure.
      const { hashEmail, normalizeEmail } = await import('@probe/core');
      const { loadEnv } = await import('@probe/config');
      const { eraseByHash, isSuppressed } = await import('@probe/db');
      const raw = flags.positional[0];
      if (!raw) {
        console.error('usage: cli erase <email|hash> --yes');
        return 2;
      }

      let hash: string;
      if (/^[0-9a-f]{64}$/i.test(raw)) {
        hash = raw.toLowerCase();
      } else {
        const norm = normalizeEmail(raw);
        if (!norm) {
          console.error(`"${raw}" is neither an email address nor a 64 character hash`);
          return 1;
        }
        hash = hashEmail(norm, loadEnv().PROBE_HASH_PEPPER);
        console.log(`normalized  ${norm}`);
      }
      console.log(`hash        ${hash}`);
      console.log(`suppressed  ${(await isSuppressed(hash)) ? 'yes' : 'no'}`);

      if (!flags.yes) {
        console.log('');
        console.log('This deletes the contact rows, the sends and their events for that hash,');
        console.log('across every campaign. The suppression row itself is KEPT on purpose:');
        console.log('deleting it would make the address contactable again, which is the');
        console.log('opposite of what the person asked for, and it holds only a peppered hash.');
        console.log('Pass --yes to do it.');
        return 1;
      }

      const counts = await eraseByHash(hash);
      console.log('');
      for (const [table, n] of Object.entries(counts)) {
        console.log(`  ${table.padEnd(20)} ${n}`);
      }
      return 0;
    }

    case 'resolve': {
      const { runResolve } = await import('./jobs/resolve');
      const s = await runResolve();
      console.log(
        `considered ${s.considered}  matched ${s.matched}  resolved ${s.resolved}\n` +
          `  jurisdiction_blocked ${s.jurisdiction_blocked}  no_match ${s.no_match}\n` +
          `  suppressed ${s.suppressed}  contacted_other_campaign ${s.contacted_other_campaign}\n` +
          `  no_contact ${s.no_contact}`,
      );
      return 0;
    }

    case 'generate': {
      const { runGenerate } = await import('./jobs/generate');
      const s = await runGenerate();
      console.log(
        `considered ${s.considered}  ready ${s.ready}  pending ${s.pending}  ` +
          `no_proof ${s.no_proof}  failed ${s.failed}`,
      );
      return 0;
    }

    case 'send': {
      const { sendOnce } = await import('./jobs/send');
      const { sendEnabled } = await import('./send/runtime');
      console.log(`PROBE_SEND_ENABLED=${sendEnabled()}`);
      const s = await sendOnce();
      console.log(
        `attempted ${s.attempted}  sent ${s.sent}  skipped ${s.skipped}  failed ${s.failed}`,
      );
      if (s.reason) console.log(`  ${s.reason}`);
      return s.failed > 0 ? 1 : 0;
    }

    case 'autopause': {
      const { runAutoPause } = await import('./jobs/autopause');
      const s = await runAutoPause();
      for (const c of s.checks) {
        console.log(
          `${c.slug.padEnd(10)} ${c.action.padEnd(14)} sent ${c.sent}  ` +
            `bounce ${(c.bounce_rate * 100).toFixed(3)}%  complaint ${(c.complaint_rate * 100).toFixed(3)}%` +
            (c.reason ? `  ${c.reason}` : ''),
        );
      }
      console.log(`checked ${s.checked}  paused ${s.paused}  low volume ${s.low_volume}`);
      return 0;
    }

    case 'health': {
      const { healthStats, dashboardStats } = await import('@probe/db');
      const { loadConfig } = await import('@probe/config');
      const { sendEnabled } = await import('./send/runtime');
      const cfg = loadConfig();
      const now = new Date();
      const dash = await dashboardStats(cfg.global.timezone, now);
      const health = await healthStats(cfg.global.rate_window_days);

      console.log(`send_enabled: ${sendEnabled()}`);
      console.log(
        `today: swept ${dash.swept_today}  matched ${dash.matched_today}  ` +
          `contacts ${dash.contacts_today}  ready ${dash.proofs_ready}  ` +
          `awaiting ${dash.awaiting_approval}  sent ${dash.sent_today}  ` +
          `clicks ${dash.clicks_today}  replies ${dash.replies_today}`,
      );
      console.log('');
      console.log('campaigns');
      for (const c of dash.campaigns) {
        console.log(
          `  ${c.slug.padEnd(10)} ${c.paused ? 'paused ' : 'active '} ` +
            `warmup day ${c.warmup_day}  cap ${c.daily_cap}  sent today ${c.sent_today}`,
        );
      }
      console.log('');
      console.log('sources');
      for (const s of health.sources) {
        console.log(
          `  ${s.id.padEnd(14)} ${s.enabled ? 'on ' : 'off'}  ` +
            `last swept ${s.last_swept_at ? s.last_swept_at.toISOString() : 'never'}` +
            (s.last_error ? `  error: ${s.last_error}` : ''),
        );
      }
      console.log('');
      console.log(
        `generator: ready ${health.generator.ready}  no_proof ${health.generator.no_proof}  ` +
          `failed ${health.generator.failed}  pending ${health.generator.pending}`,
      );
      console.log(
        `rates over ${health.rates.window_days} days: sent ${health.rates.sent}  ` +
          `bounce ${(health.rates.bounce_rate * 100).toFixed(3)}% ` +
          `(threshold ${(cfg.global.bounce_rate_threshold * 100).toFixed(3)}%)  ` +
          `complaint ${(health.rates.complaint_rate * 100).toFixed(3)}% ` +
          `(threshold ${(cfg.global.complaint_rate_threshold * 100).toFixed(3)}%)`,
      );
      console.log('');
      console.log('drop reasons, as a share of matched leads');
      for (const d of health.drop_reasons) {
        console.log(
          `  ${d.reason.padEnd(26)} ${String(d.count).padStart(5)}  ` +
            `${(d.share_of_matched * 100).toFixed(1)}%`,
        );
      }
      console.log(
        `jurisdiction_blocked ${health.jurisdiction.blocked} of ${health.jurisdiction.swept} swept  ` +
          `(${(health.jurisdiction.share_blocked * 100).toFixed(1)}%)`,
      );
      console.log(
        `contacted_other_campaign ${health.contacted_other_campaign.count}  ` +
          `(${(health.contacted_other_campaign.share_of_matched * 100).toFixed(1)}% of matched)`,
      );
      return 0;
    }
  }
}

function safe(fn: () => string): string {
  try {
    return fn();
  } catch (err) {
    return `unavailable (${describe(err)})`;
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Today's calendar date in a timezone, as YYYY-MM-DD. en-CA renders that shape
 *  natively, which is why it is the locale rather than a manual assembly. */
function todayIn(timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

/** Closes the pool only when a command that could have opened one ran. */
async function closeIfOpen(): Promise<void> {
  if (!usedDatabase) return;
  try {
    const db = await import('@probe/db');
    await db.closeSql();
  } catch {
    // Never connected. Nothing to close.
  }
}

main()
  .then(async (code) => {
    await closeIfOpen();
    process.exitCode = code;
  })
  .catch(async (err: unknown) => {
    console.error(err instanceof Error ? err.stack ?? err.message : String(err));
    await closeIfOpen();
    process.exitCode = 1;
  });
