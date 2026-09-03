import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, resetConfigCache } from './config';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const REAL_TOML = path.join(REPO_ROOT, 'probe.toml');

let tmpDir: string;

function writeToml(body: string): string {
  const p = path.join(tmpDir, `probe-${Math.random().toString(36).slice(2)}.toml`);
  fs.writeFileSync(p, body, 'utf8');
  return p;
}

const MINIMAL_GLOBAL = `
[global]
postal_address = "Pradsgaard Labs, Somewhere 1, 8000 Aarhus, Denmark"
`;

const MINIMAL_CAMPAIGN = `
[campaigns.exit1]
product       = "exit1.dev"
generator_url = "https://exit1.dev/api/probe/generate"
from_name     = "Morten Pradsgaard"
from_email    = "morten@mail.exit1.dev"
`;

beforeEach(() => {
  resetConfigCache();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-config-'));
});

afterEach(() => {
  resetConfigCache();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('§9.1 the DK refusal', () => {
  it('refuses to load when DK is missing from blocked_countries', () => {
    const p = writeToml(`
[global]
postal_address = "x"
blocked_countries = ["DE"]
${MINIMAL_CAMPAIGN}`);
    expect(() => loadConfig({ path: p })).toThrow(ConfigError);
    expect(() => loadConfig({ path: p })).toThrow(/DK/);
  });

  it('refuses an empty blocklist, which would contact everyone', () => {
    const p = writeToml(`
[global]
postal_address = "x"
blocked_countries = []
${MINIMAL_CAMPAIGN}`);
    expect(() => loadConfig({ path: p })).toThrow(ConfigError);
  });

  it('accepts lower case dk, since countries normalise before the check', () => {
    const p = writeToml(`
[global]
postal_address = "x"
blocked_countries = ["dk"]
${MINIMAL_CAMPAIGN}`);
    expect(loadConfig({ path: p }).global.blocked_countries).toEqual(['DK']);
  });

  it('normalises countries to upper case', () => {
    const p = writeToml(`
[global]
postal_address = "x"
blocked_countries = ["dk", "de"]
${MINIMAL_CAMPAIGN}`);
    expect(loadConfig({ path: p }).global.blocked_countries).toEqual(['DK', 'DE']);
  });

  it('rejects anything that is not a two letter code', () => {
    const p = writeToml(`
[global]
postal_address = "x"
blocked_countries = ["DNK"]
${MINIMAL_CAMPAIGN}`);
    expect(() => loadConfig({ path: p })).toThrow(/alpha-2/);
  });
});

describe('the committed probe.toml', () => {
  it('parses and carries the shipped values', () => {
    const cfg = loadConfig({ path: REAL_TOML });
    expect(cfg.global.timezone).toBe('Europe/Copenhagen');
    expect(cfg.global.send_window).toEqual(['09:00', '16:00']);
    expect(cfg.global.send_days).toEqual(['mon', 'tue', 'wed', 'thu', 'fri']);
    expect(cfg.global.blocked_countries).toEqual(['DK', 'DE']);
    expect(cfg.global.gap_floor_minutes).toBe(4);
    expect(cfg.global.gap_jitter).toBe(0.4);
    expect(cfg.global.generator_min_severity).toBe(1);
    expect(cfg.global.generator_budget_ms).toBe(7_200_000);
    expect(cfg.global.public_base_url).toBe('https://probe.exit1.dev');
  });

  it('turns [campaigns.*] into an array in file order, slug from the key', () => {
    const cfg = loadConfig({ path: REAL_TOML });
    expect(cfg.campaigns.map((c) => c.slug)).toEqual(['exit1', 'day3']);

    const exit1 = cfg.campaigns[0];
    expect(exit1.product).toBe('exit1.dev');
    // The Cloud Function directly, not exit1.dev/api/probe/generate: exit1.dev
    // is served by Vercel with no vercel.json, so the Firebase Hosting rewrites
    // are inert. Asserted loosely on purpose -- the exact host is deployment
    // detail, but it must stay https and reachable, which the schema enforces.
    expect(exit1.generator_url).toMatch(/^https:\/\//);
    expect(exit1.generator_url).toContain('probeGenerate');
    expect(exit1.from_email).toBe('morten@mail.exit1.dev');
    expect(exit1.reply_to).toBe('morten@mail.exit1.dev');
    expect(exit1.daily_cap).toBe(50);
    expect(exit1.exclude_tags).toContain('monitoring');
    expect(exit1.exclude_keywords).toContain('status page');

    expect(cfg.campaigns[1].daily_cap).toBe(25);
    expect(cfg.campaigns[1].exclude_tags).toEqual([]);
  });

  it('is found by walking up from a nested cwd', () => {
    const cfg = loadConfig({ cwd: path.join(REPO_ROOT, 'packages', 'config', 'src') });
    expect(cfg.campaigns.map((c) => c.slug)).toEqual(['exit1', 'day3']);
  });

  it('caches by resolved path', () => {
    const a = loadConfig({ path: REAL_TOML });
    const b = loadConfig({ path: REAL_TOML });
    expect(a).toBe(b);
    resetConfigCache();
    expect(loadConfig({ path: REAL_TOML })).not.toBe(a);
  });
});

describe('send_window validation', () => {
  it('rejects a window whose start is not before its end', () => {
    const p = writeToml(`
[global]
postal_address = "x"
send_window = ["16:00", "09:00"]
${MINIMAL_CAMPAIGN}`);
    expect(() => loadConfig({ path: p })).toThrow(/earlier than end/);
  });

  it('rejects a malformed time', () => {
    const p = writeToml(`
[global]
postal_address = "x"
send_window = ["9am", "16:00"]
${MINIMAL_CAMPAIGN}`);
    expect(() => loadConfig({ path: p })).toThrow(ConfigError);
  });

  it('rejects a window that is not a pair', () => {
    const p = writeToml(`
[global]
postal_address = "x"
send_window = ["09:00", "12:00", "16:00"]
${MINIMAL_CAMPAIGN}`);
    expect(() => loadConfig({ path: p })).toThrow(ConfigError);
  });
});

describe('pacing validation', () => {
  it('rejects gap_jitter above 1', () => {
    const p = writeToml(`
[global]
postal_address = "x"
gap_jitter = 1.5
${MINIMAL_CAMPAIGN}`);
    expect(() => loadConfig({ path: p })).toThrow(ConfigError);
  });

  it('rejects a negative gap_jitter', () => {
    const p = writeToml(`
[global]
postal_address = "x"
gap_jitter = -0.1
${MINIMAL_CAMPAIGN}`);
    expect(() => loadConfig({ path: p })).toThrow(ConfigError);
  });

  it('rejects a gap floor below one minute', () => {
    const p = writeToml(`
[global]
postal_address = "x"
gap_floor_minutes = 0
${MINIMAL_CAMPAIGN}`);
    expect(() => loadConfig({ path: p })).toThrow(ConfigError);
  });
});

describe('campaign validation', () => {
  it('rejects a non https generator_url', () => {
    const p = writeToml(`${MINIMAL_GLOBAL}
[campaigns.exit1]
product = "exit1.dev"
generator_url = "http://exit1.dev/api/probe/generate"
from_name = "Morten"
from_email = "morten@mail.exit1.dev"
`);
    expect(() => loadConfig({ path: p })).toThrow(/https/);
  });

  it('rejects an implausible from_email', () => {
    const p = writeToml(`${MINIMAL_GLOBAL}
[campaigns.exit1]
product = "exit1.dev"
generator_url = "https://exit1.dev/api/probe/generate"
from_name = "Morten"
from_email = "morten-at-exit1"
`);
    expect(() => loadConfig({ path: p })).toThrow(/email/);
  });

  it('rejects a campaign missing a required field', () => {
    const p = writeToml(`${MINIMAL_GLOBAL}
[campaigns.exit1]
product = "exit1.dev"
generator_url = "https://exit1.dev/api/probe/generate"
`);
    expect(() => loadConfig({ path: p })).toThrow(ConfigError);
  });

  it('rejects a file with no campaigns at all', () => {
    const p = writeToml(MINIMAL_GLOBAL);
    expect(() => loadConfig({ path: p })).toThrow(/no \[campaigns/);
  });

  it('applies campaign defaults', () => {
    const p = writeToml(MINIMAL_GLOBAL + MINIMAL_CAMPAIGN);
    const c = loadConfig({ path: p }).campaigns[0];
    expect(c.daily_cap).toBe(50);
    expect(c.exclude_tags).toEqual([]);
    expect(c.exclude_keywords).toEqual([]);
    expect(c.reply_to).toBeUndefined();
  });
});

describe('global defaults', () => {
  it('fills in everything absent from a minimal file', () => {
    const p = writeToml(MINIMAL_GLOBAL + MINIMAL_CAMPAIGN);
    const g = loadConfig({ path: p }).global;
    expect(g.timezone).toBe('Europe/Copenhagen');
    expect(g.send_window).toEqual(['09:00', '16:00']);
    expect(g.blocked_countries).toEqual(['DK', 'DE']);
    expect(g.generator_concurrency).toBe(3);
    expect(g.generator_max_attempts).toBe(3);
    expect(g.rate_window_days).toBe(7);
    expect(g.paid_lookup_monthly_cap).toBe(50);
  });

  it('strips a trailing slash from public_base_url', () => {
    const p = writeToml(`
[global]
postal_address = "x"
public_base_url = "https://probe.exit1.dev/"
${MINIMAL_CAMPAIGN}`);
    expect(loadConfig({ path: p }).global.public_base_url).toBe('https://probe.exit1.dev');
  });

  it('requires postal_address, since CAN-SPAM does', () => {
    const p = writeToml(`
[global]
timezone = "Europe/Copenhagen"
${MINIMAL_CAMPAIGN}`);
    expect(() => loadConfig({ path: p })).toThrow(ConfigError);
  });
});

describe('file discovery', () => {
  it('throws ConfigError when there is no probe.toml anywhere above cwd', () => {
    const isolated = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-empty-'));
    // The temp dir is outside the repo, so the walk reaches the filesystem root.
    expect(() => loadConfig({ cwd: isolated })).toThrow(ConfigError);
    fs.rmSync(isolated, { recursive: true, force: true });
  });

  it('throws ConfigError for invalid TOML', () => {
    const p = writeToml('[global\nbroken');
    expect(() => loadConfig({ path: p })).toThrow(/not valid TOML/);
  });
});
