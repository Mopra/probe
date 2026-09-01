import * as fs from 'node:fs';
import * as path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { z } from 'zod';
import { CampaignSchema, FileSchema, GlobalSchema, type Weekday } from './schema';

export type { Weekday };

export interface GlobalConfig {
  timezone: string;
  send_days: Weekday[];
  send_window: [string, string];
  gap_floor_minutes: number;
  gap_jitter: number;
  allowed_countries: string[];
  postal_address: string;
  public_base_url: string;
  generator_concurrency: number;
  generator_timeout_ms: number;
  generator_budget_ms: number;
  generator_max_attempts: number;
  generator_min_severity: number;
  complaint_rate_threshold: number;
  bounce_rate_threshold: number;
  rate_window_days: number;
  paid_lookup_monthly_cap: number;
}

export interface CampaignConfig {
  slug: string;
  product: string;
  generator_url: string;
  from_name: string;
  from_email: string;
  reply_to?: string;
  daily_cap: number;
  exclude_tags: string[];
  exclude_keywords: string[];
}

export interface ProbeConfig {
  global: GlobalConfig;
  campaigns: CampaignConfig[];
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * §9.1. Denmark is never allowlisted, and the loader refuses to start rather
 * than letting a config edit quietly turn on cold email into the home
 * regulator's jurisdiction. This is a hard rule, not a validation rule, so it
 * lives here rather than in the zod schema where a future refactor could relax
 * it by accident.
 */
const NEVER_ALLOWED = new Set(['DK']);

const CONFIG_FILENAME = 'probe.toml';

const cache = new Map<string, ProbeConfig>();

/** Test seam: drops the cache. */
export function resetConfigCache(): void {
  cache.clear();
}

/**
 * Walks up from `from` looking for probe.toml. Both apps/web and apps/worker
 * run with a cwd below the repo root, so neither can hard code the path.
 */
function findConfigFile(from: string): string {
  let dir = path.resolve(from);
  for (;;) {
    const candidate = path.join(dir, CONFIG_FILENAME);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new ConfigError(
    `${CONFIG_FILENAME} not found in ${path.resolve(from)} or any parent directory`,
  );
}

function formatZodIssues(prefix: string, err: z.ZodError): string {
  const lines = err.issues.map((i) => {
    const at = i.path.length ? i.path.join('.') : '(root)';
    return `  ${at}: ${i.message}`;
  });
  return `${prefix}\n${lines.join('\n')}`;
}

/**
 * Reads probe.toml, validates with zod, applies defaults. Throws ConfigError if
 * 'DK' appears in allowed_countries (§9.1), if the window is malformed, or if
 * any campaign is incomplete. Searches upward from cwd for probe.toml when no
 * path is given. Cached by resolved path.
 */
export function loadConfig(opts?: { path?: string; cwd?: string }): ProbeConfig {
  const resolved = opts?.path
    ? path.resolve(opts.path)
    : findConfigFile(opts?.cwd ?? process.cwd());

  const cached = cache.get(resolved);
  if (cached) return cached;

  let raw: string;
  try {
    raw = fs.readFileSync(resolved, 'utf8');
  } catch (err) {
    throw new ConfigError(`cannot read ${resolved}: ${(err as Error).message}`);
  }

  let doc: unknown;
  try {
    doc = parseToml(raw);
  } catch (err) {
    throw new ConfigError(`${resolved} is not valid TOML: ${(err as Error).message}`);
  }

  const shape = FileSchema.safeParse(doc);
  if (!shape.success) {
    throw new ConfigError(formatZodIssues(`invalid ${resolved}:`, shape.error));
  }

  const globalParsed = shape.data.global as z.infer<typeof GlobalSchema>;

  const offending = globalParsed.allowed_countries.filter((c) => NEVER_ALLOWED.has(c));
  if (offending.length > 0) {
    throw new ConfigError(
      `${resolved}: allowed_countries contains ${offending.join(', ')}. ` +
        'Denmark is never allowlisted (PLAN.md §9.1): cold email into the home ' +
        'regulator\'s jurisdiction is not a configuration option.',
    );
  }

  // Preserve file order for campaigns. Downstream round robin and the /queue
  // ordering both read this array, so a stable order matters.
  const campaignTable = (doc as { campaigns?: Record<string, unknown> }).campaigns ?? {};
  const slugs = Object.keys(campaignTable);

  const campaigns: CampaignConfig[] = slugs.map((slug) => {
    const parsed = shape.data.campaigns[slug] as z.infer<typeof CampaignSchema>;
    return { slug, ...parsed };
  });

  if (campaigns.length === 0) {
    throw new ConfigError(`${resolved}: no [campaigns.*] tables defined`);
  }

  const config: ProbeConfig = {
    global: {
      ...globalParsed,
      send_window: [globalParsed.send_window[0], globalParsed.send_window[1]],
      // De-duplicate while keeping order, so a repeated country cannot skew any
      // count that iterates the allowlist.
      allowed_countries: Array.from(new Set(globalParsed.allowed_countries)),
    },
    campaigns,
  };

  cache.set(resolved, config);
  return config;
}
