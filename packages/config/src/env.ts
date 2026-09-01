import { ConfigError, loadConfig } from './config';

export interface Env {
  SUPABASE_DB_URL: string;
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_KEY?: string;
  PROBE_HASH_PEPPER: string;
  PROBE_HMAC_SECRET: string;
  PROBE_SEND_ENABLED: boolean;
  PROBE_PUBLIC_URL?: string;
  PROBE_APPROVER: string;
  PROBE_OUTBOX_DIR: string;
  /** §5.1. The Day3 API key probe sends through. `day3_live_…`. */
  DAY3_API_KEY?: string;
  DAY3_API_BASE_URL: string;
  /** `whsec_…`, from the Day3 webhook endpoint. Verifies /hooks/day3. */
  DAY3_WEBHOOK_SECRET?: string;
  /** SNS topic ARNs allowed to post inbound mail to /hooks/ses. */
  SNS_ALLOWED_TOPIC_ARNS: string[];
  REPLY_FORWARD_TO?: string;
  PRODUCT_HUNT_TOKEN?: string;
  FINDYMAIL_KEY?: string;
}

/**
 * Worker-only secrets. A Next.js build imports code that transitively imports
 * this module, so validation has to stay behind the loadEnv() call: an eager
 * check at import time would fail the web build on a var only the VPS has.
 */
const REQUIRED = ['SUPABASE_DB_URL', 'PROBE_HASH_PEPPER', 'PROBE_HMAC_SECRET'] as const;

const DEFAULT_DAY3_BASE_URL = 'https://day3.app';

let cached: Env | null = null;

export function resetEnvCache(): void {
  cached = null;
}

function opt(raw: string | undefined): string | undefined {
  const v = raw?.trim();
  return v ? v : undefined;
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

export function loadEnv(): Env {
  if (cached) return cached;

  const src = process.env;

  // Report every missing var at once. Discovering them one restart at a time is
  // the difference between a thirty second fix and a ten minute one.
  const missing = REQUIRED.filter((k) => !opt(src[k]));
  if (missing.length > 0) {
    throw new ConfigError(
      `missing required environment variable${missing.length > 1 ? 's' : ''}: ` +
        `${missing.join(', ')}. See .env.example.`,
    );
  }

  const env: Env = {
    SUPABASE_DB_URL: opt(src.SUPABASE_DB_URL)!,
    SUPABASE_URL: opt(src.SUPABASE_URL),
    SUPABASE_SERVICE_KEY: opt(src.SUPABASE_SERVICE_KEY),
    PROBE_HASH_PEPPER: opt(src.PROBE_HASH_PEPPER)!,
    PROBE_HMAC_SECRET: opt(src.PROBE_HMAC_SECRET)!,
    // §3.1 rule 4: dry-run is the default. Anything but the exact string 'true'
    // means no mail leaves the building, so 'TRUE', '1' and 'yes' are all false.
    PROBE_SEND_ENABLED: src.PROBE_SEND_ENABLED === 'true',
    PROBE_PUBLIC_URL: opt(src.PROBE_PUBLIC_URL)?.replace(/\/+$/, ''),
    PROBE_APPROVER: opt(src.PROBE_APPROVER) ?? 'morten',
    PROBE_OUTBOX_DIR: opt(src.PROBE_OUTBOX_DIR) ?? './outbox',
    DAY3_API_KEY: opt(src.DAY3_API_KEY),
    DAY3_API_BASE_URL: stripTrailingSlash(opt(src.DAY3_API_BASE_URL) ?? DEFAULT_DAY3_BASE_URL),
    DAY3_WEBHOOK_SECRET: opt(src.DAY3_WEBHOOK_SECRET),
    SNS_ALLOWED_TOPIC_ARNS: (opt(src.SNS_ALLOWED_TOPIC_ARNS) ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
    REPLY_FORWARD_TO: opt(src.REPLY_FORWARD_TO),
    PRODUCT_HUNT_TOKEN: opt(src.PRODUCT_HUNT_TOKEN),
    FINDYMAIL_KEY: opt(src.FINDYMAIL_KEY),
  };

  cached = env;
  return env;
}

/**
 * public_base_url with PROBE_PUBLIC_URL taking precedence, so a preview
 * deployment can point unsubscribe links at itself without editing the
 * committed config. No trailing slash.
 */
export function publicBaseUrl(): string {
  const override = opt(process.env.PROBE_PUBLIC_URL);
  if (override) return stripTrailingSlash(override);
  return loadConfig().global.public_base_url;
}

// ---------------------------------------------------------------------------
// Send preflight
// ---------------------------------------------------------------------------

export interface PreflightProblem {
  key: string;
  problem: string;
}

/**
 * Everything that must be true before real mail may leave, checked in one place
 * so `cli preflight` and the worker's own boot check cannot disagree.
 *
 * Only called when PROBE_SEND_ENABLED is true. In dry-run the outbox does not
 * care whether the base URL is reachable, and demanding a Day3 key on a laptop
 * would break the M0 harness that §13 says to live in for two weeks.
 *
 * The base URL check is the one that earns its place. `.env.example` ships
 * `PROBE_PUBLIC_URL=http://localhost:3000`, and that value silently wins over
 * probe.toml. Copy the example to the VPS, miss that one line, and every
 * unsubscribe link, every List-Unsubscribe header and every data-notice link in
 * every real email points at a host the recipient cannot reach. That is a
 * compliance incident produced by a default, so it is checked rather than
 * trusted.
 */
export function sendPreflight(): PreflightProblem[] {
  const problems: PreflightProblem[] = [];
  const env = loadEnv();

  if (!env.DAY3_API_KEY) {
    problems.push({
      key: 'DAY3_API_KEY',
      problem: 'not set. probe sends through the Day3 API (§5.1); without a key nothing can send.',
    });
  } else if (!/^day3_live_[A-Za-z0-9]{40}$/.test(env.DAY3_API_KEY)) {
    problems.push({
      key: 'DAY3_API_KEY',
      problem:
        env.DAY3_API_KEY.startsWith('day3_test_')
          ? 'is a test-mode key. Day3 does not accept those; use a live key.'
          : 'is not shaped like a Day3 live key (day3_live_ plus 40 characters).',
    });
  }

  if (!env.DAY3_WEBHOOK_SECRET) {
    problems.push({
      key: 'DAY3_WEBHOOK_SECRET',
      problem:
        'not set. Without it /hooks/day3 rejects every delivery, so bounces and complaints ' +
        'never reach the suppression list and the §5.5 auto-pause is blind.',
    });
  } else if (!env.DAY3_WEBHOOK_SECRET.startsWith('whsec_')) {
    problems.push({
      key: 'DAY3_WEBHOOK_SECRET',
      problem: 'does not start with whsec_, so it is not a Day3 webhook signing secret.',
    });
  }

  let base: URL | null = null;
  try {
    base = new URL(publicBaseUrl());
  } catch {
    base = null;
  }
  if (base === null) {
    problems.push({ key: 'PROBE_PUBLIC_URL', problem: 'is not an absolute URL.' });
  } else {
    if (base.protocol !== 'https:') {
      problems.push({
        key: 'PROBE_PUBLIC_URL',
        problem:
          `is ${base.protocol}//, not https. RFC 8058 one-click unsubscribe requires https, ` +
          'and Day3 refuses a non-https list_unsubscribe URL.',
      });
    }
    const host = base.hostname.toLowerCase();
    const local =
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '::1' ||
      host.endsWith('.local') ||
      host.endsWith('.localhost');
    if (local) {
      problems.push({
        key: 'PROBE_PUBLIC_URL',
        problem:
          `points at ${host}. Every unsubscribe, click and data-notice link in every email ` +
          'would be unreachable for the recipient.',
      });
    }
  }

  const postal = loadConfig().global.postal_address;
  if (/[<>]/.test(postal) || !/\d/.test(postal)) {
    // The loader already refuses this, so reaching it means the schema was
    // relaxed. Repeated here because it is the one field whose absence is
    // invisible in the rendered email until a regulator reads it.
    problems.push({
      key: 'probe.toml postal_address',
      problem: 'is not a real physical address, which CAN-SPAM (§9.2.7) requires in every footer.',
    });
  }

  return problems;
}

/** Throws unless sendPreflight() is clean. Called on worker boot when live. */
export function assertSendReady(): void {
  const problems = sendPreflight();
  if (problems.length === 0) return;
  throw new ConfigError(
    'PROBE_SEND_ENABLED is true but the send configuration is not ready:\n' +
      problems.map((p) => `  ${p.key}: ${p.problem}`).join('\n') +
      '\n\nRun `pnpm --filter @probe/worker cli preflight` for the same list, or set ' +
      'PROBE_SEND_ENABLED=false to stay in dry-run.',
  );
}
