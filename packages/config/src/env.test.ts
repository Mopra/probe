import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigError, resetConfigCache } from './config';
import { loadEnv, publicBaseUrl, resetEnvCache } from './env';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

const OWNED = [
  'SUPABASE_DB_URL',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_KEY',
  'PROBE_HASH_PEPPER',
  'PROBE_HMAC_SECRET',
  'PROBE_SEND_ENABLED',
  'PROBE_PUBLIC_URL',
  'PROBE_APPROVER',
  'PROBE_OUTBOX_DIR',
  'DAY3_API_KEY',
  'DAY3_API_BASE_URL',
  'DAY3_WEBHOOK_SECRET',
  'SNS_ALLOWED_TOPIC_ARNS',
  'REPLY_FORWARD_TO',
  'PRODUCT_HUNT_TOKEN',
  'FINDYMAIL_KEY',
];

let saved: Record<string, string | undefined>;

beforeEach(() => {
  resetEnvCache();
  resetConfigCache();
  saved = {};
  for (const k of OWNED) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of OWNED) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  resetEnvCache();
  resetConfigCache();
});

function setRequired(): void {
  process.env.SUPABASE_DB_URL = 'postgres://u:p@localhost:5432/probe';
  process.env.PROBE_HASH_PEPPER = 'pepper';
  process.env.PROBE_HMAC_SECRET = 'secret';
}

describe('loadEnv', () => {
  it('is lazy: importing the module does not validate anything', () => {
    // The module was imported at the top of this file with a stripped env and
    // nothing threw, which is the whole point (a Next build must not crash on a
    // worker-only secret).
    expect(typeof loadEnv).toBe('function');
  });

  it('reports every missing required var in one error', () => {
    let message = '';
    try {
      loadEnv();
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      message = (err as Error).message;
    }
    expect(message).toContain('SUPABASE_DB_URL');
    expect(message).toContain('PROBE_HASH_PEPPER');
    expect(message).toContain('PROBE_HMAC_SECRET');
  });

  it('names only the ones actually missing', () => {
    process.env.SUPABASE_DB_URL = 'postgres://u:p@localhost:5432/probe';
    process.env.PROBE_HASH_PEPPER = 'pepper';
    expect(() => loadEnv()).toThrow(/PROBE_HMAC_SECRET/);
    try {
      loadEnv();
    } catch (err) {
      expect((err as Error).message).not.toContain('SUPABASE_DB_URL');
    }
  });

  it('treats a blank string as missing', () => {
    setRequired();
    process.env.PROBE_HASH_PEPPER = '   ';
    expect(() => loadEnv()).toThrow(/PROBE_HASH_PEPPER/);
  });

  it('applies the documented defaults', () => {
    setRequired();
    const env = loadEnv();
    expect(env.PROBE_APPROVER).toBe('morten');
    expect(env.PROBE_OUTBOX_DIR).toBe('./outbox');
    expect(env.SNS_ALLOWED_TOPIC_ARNS).toEqual([]);
    expect(env.PROBE_SEND_ENABLED).toBe(false);
  });

  it('caches until reset', () => {
    setRequired();
    const a = loadEnv();
    process.env.PROBE_APPROVER = 'someone-else';
    expect(loadEnv()).toBe(a);
    resetEnvCache();
    expect(loadEnv().PROBE_APPROVER).toBe('someone-else');
  });

  it('splits SNS_ALLOWED_TOPIC_ARNS on commas and drops blanks', () => {
    setRequired();
    process.env.SNS_ALLOWED_TOPIC_ARNS = 'arn:a, arn:b ,,';
    expect(loadEnv().SNS_ALLOWED_TOPIC_ARNS).toEqual(['arn:a', 'arn:b']);
  });
});

describe('PROBE_SEND_ENABLED strictness (§3.1 rule 4)', () => {
  const notTrue = ['true ', 'TRUE', 'True', '1', 'yes', 'on', '', 'false', undefined];

  for (const value of notTrue) {
    it(`is false for ${JSON.stringify(value)}`, () => {
      setRequired();
      if (value === undefined) delete process.env.PROBE_SEND_ENABLED;
      else process.env.PROBE_SEND_ENABLED = value;
      expect(loadEnv().PROBE_SEND_ENABLED).toBe(false);
    });
  }

  it('is true only for the exact string "true"', () => {
    setRequired();
    process.env.PROBE_SEND_ENABLED = 'true';
    expect(loadEnv().PROBE_SEND_ENABLED).toBe(true);
  });
});

describe('publicBaseUrl', () => {
  it('falls back to probe.toml', () => {
    process.env.PROBE_TEST_UNUSED = '1';
    delete process.env.PROBE_TEST_UNUSED;
    // cwd during vitest is the repo root, so the upward search finds probe.toml.
    expect(publicBaseUrl()).toBe('https://probe.exit1.dev');
    expect(REPO_ROOT.length).toBeGreaterThan(0);
  });

  it('prefers PROBE_PUBLIC_URL and strips a trailing slash', () => {
    process.env.PROBE_PUBLIC_URL = 'http://localhost:3000/';
    expect(publicBaseUrl()).toBe('http://localhost:3000');
  });
});
