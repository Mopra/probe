import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { assertSendReady, loadEnv, resetEnvCache, sendPreflight } from './env';
import { resetConfigCache } from './config';

/**
 * The preflight exists because every problem it reports produces an email that
 * looks fine in the log and is broken in the recipient's inbox. Each test below
 * is one of those, and each one has actually been reachable: `.env.example`
 * ships PROBE_PUBLIC_URL=http://localhost:3000, and that value silently wins
 * over probe.toml.
 */

const GOOD_KEY = `day3_live_${'a'.repeat(40)}`;

let saved: NodeJS.ProcessEnv;
let dir: string;

function writeConfig(postalAddress: string, publicBaseUrl = 'https://probe.exit1.dev'): string {
  const file = path.join(dir, 'probe.toml');
  fs.writeFileSync(
    file,
    [
      '[global]',
      `postal_address = "${postalAddress}"`,
      `public_base_url = "${publicBaseUrl}"`,
      '',
      '[campaigns.exit1]',
      'product = "exit1.dev"',
      'generator_url = "https://exit1.dev/api/probe/generate"',
      'from_name = "Morten Pradsgaard"',
      'from_email = "morten@mail.exit1.dev"',
    ].join('\n'),
    'utf8',
  );
  return file;
}

beforeEach(() => {
  saved = { ...process.env };
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-preflight-'));
  process.env.SUPABASE_DB_URL = 'postgres://u:p@localhost:5432/probe';
  process.env.PROBE_HASH_PEPPER = 'pepper';
  process.env.PROBE_HMAC_SECRET = 'secret';
  process.env.PROBE_SEND_ENABLED = 'true';
  process.env.DAY3_API_KEY = GOOD_KEY;
  process.env.DAY3_WEBHOOK_SECRET = 'whsec_abc';
  delete process.env.PROBE_PUBLIC_URL;
  resetEnvCache();
  resetConfigCache();
});

afterEach(() => {
  process.env = saved;
  resetEnvCache();
  resetConfigCache();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** loadConfig() finds probe.toml by walking up from cwd, so the fixture has to
 *  be reachable that way. Running from the temp dir is the least invasive. */
function inTempCwd<T>(fn: () => T): T {
  const previous = process.cwd();
  process.chdir(dir);
  try {
    resetConfigCache();
    return fn();
  } finally {
    process.chdir(previous);
    resetConfigCache();
  }
}

function problems(): string[] {
  return inTempCwd(() => sendPreflight().map((p) => p.key));
}

describe('sendPreflight', () => {
  it('is clean when everything is in place', () => {
    writeConfig('Pradsgaard Labs, Vestergade 12, 8000 Aarhus, Denmark');
    expect(problems()).toEqual([]);
  });

  it('catches a localhost base url, which is what .env.example ships', () => {
    writeConfig('Pradsgaard Labs, Vestergade 12, 8000 Aarhus, Denmark');
    process.env.PROBE_PUBLIC_URL = 'http://localhost:3000';
    resetEnvCache();
    const found = inTempCwd(() => sendPreflight());
    // Two distinct faults in one value, and the operator should hear both:
    // it is not https, and it is not reachable.
    expect(found.filter((p) => p.key === 'PROBE_PUBLIC_URL')).toHaveLength(2);
    expect(found.map((p) => p.problem).join(' ')).toContain('https');
    expect(found.map((p) => p.problem).join(' ')).toContain('unreachable');
  });

  it('catches a non-https base url even on a real host', () => {
    // Day3 refuses a non-https list_unsubscribe, so this would fail at send
    // time with a confusing provider error instead of at boot.
    writeConfig('Pradsgaard Labs, Vestergade 12, 8000 Aarhus, Denmark');
    process.env.PROBE_PUBLIC_URL = 'http://probe.exit1.dev';
    resetEnvCache();
    expect(problems()).toContain('PROBE_PUBLIC_URL');
  });

  it('catches a missing or malformed Day3 API key', () => {
    writeConfig('Pradsgaard Labs, Vestergade 12, 8000 Aarhus, Denmark');

    delete process.env.DAY3_API_KEY;
    resetEnvCache();
    expect(problems()).toContain('DAY3_API_KEY');

    process.env.DAY3_API_KEY = 'day3_test_' + 'a'.repeat(40);
    resetEnvCache();
    const testKey = inTempCwd(() => sendPreflight());
    expect(testKey.find((p) => p.key === 'DAY3_API_KEY')?.problem).toContain('test-mode');

    process.env.DAY3_API_KEY = 'sk_live_something_else';
    resetEnvCache();
    expect(problems()).toContain('DAY3_API_KEY');
  });

  it('catches a missing webhook secret, because bounces would never arrive', () => {
    writeConfig('Pradsgaard Labs, Vestergade 12, 8000 Aarhus, Denmark');
    delete process.env.DAY3_WEBHOOK_SECRET;
    resetEnvCache();
    const found = inTempCwd(() => sendPreflight());
    expect(found.map((p) => p.key)).toContain('DAY3_WEBHOOK_SECRET');
    expect(found.find((p) => p.key === 'DAY3_WEBHOOK_SECRET')?.problem).toContain('auto-pause');
  });

  it('catches the placeholder postal address', () => {
    writeConfig('Pradsgaard Labs, <street>, <zip> <city>, Denmark');
    expect(problems()).toContain('probe.toml postal_address');
  });

  it('reports every problem at once rather than one per restart', () => {
    writeConfig('Pradsgaard Labs, <street>, <zip> <city>, Denmark', 'http://localhost:3000');
    delete process.env.DAY3_API_KEY;
    delete process.env.DAY3_WEBHOOK_SECRET;
    resetEnvCache();
    const keys = problems();
    expect(new Set(keys)).toEqual(
      new Set(['DAY3_API_KEY', 'DAY3_WEBHOOK_SECRET', 'PROBE_PUBLIC_URL', 'probe.toml postal_address']),
    );
  });
});

describe('assertSendReady', () => {
  it('throws with every problem and a way out', () => {
    writeConfig('Pradsgaard Labs, <street>, <zip> <city>, Denmark');
    delete process.env.DAY3_API_KEY;
    resetEnvCache();
    try {
      inTempCwd(() => assertSendReady());
      throw new Error('expected assertSendReady to throw');
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain('DAY3_API_KEY');
      expect(message).toContain('postal_address');
      // The message has to say what to run and how to get back to safety.
      expect(message).toContain('cli preflight');
      expect(message).toContain('PROBE_SEND_ENABLED=false');
    }
  });

  it('does not throw when the configuration is ready', () => {
    writeConfig('Pradsgaard Labs, Vestergade 12, 8000 Aarhus, Denmark');
    expect(() => inTempCwd(() => assertSendReady())).not.toThrow();
  });
});

describe('the Day3 base url', () => {
  it('defaults to production and strips a trailing slash', () => {
    resetEnvCache();
    expect(loadEnv().DAY3_API_BASE_URL).toBe('https://go.day3.app');

    process.env.DAY3_API_BASE_URL = 'https://staging.day3.app/';
    resetEnvCache();
    expect(loadEnv().DAY3_API_BASE_URL).toBe('https://staging.day3.app');
  });
});
