import { loadConfig, loadEnv, logger, publicBaseUrl } from '@probe/config';
import type { Env, GlobalConfig, ProbeConfig } from '@probe/config';

const log = logger('web:lib');

/** probe.toml, or a throw. Use where the value is load bearing (approval). */
export function getConfig(): ProbeConfig {
  return loadConfig();
}

/** probe.toml, or null. Use where a missing file must not take the page down,
 *  and during a build where the file may not be traced yet. */
export function tryConfig(): ProbeConfig | null {
  try {
    return loadConfig();
  } catch (err) {
    log.warn('config unavailable', { error: String(err) });
    return null;
  }
}

/** Env, or a throw. Use where the value is load bearing. */
export function getEnv(): Env {
  return loadEnv();
}

/** Env, or null. loadEnv throws when a worker-only secret is missing, and a
 *  Next build must not die on that (§CONTRACTS @probe/config). */
export function tryEnv(): Env | null {
  try {
    return loadEnv();
  } catch (err) {
    log.warn('env unavailable', { error: String(err) });
    return null;
  }
}

/** The global kill switch (§5.5). null means the env could not be read at all,
 *  which is itself worth showing rather than guessing. */
export function sendEnabled(): boolean | null {
  const env = tryEnv();
  return env ? env.PROBE_SEND_ENABLED : null;
}

const FALLBACK_TIMEZONE = 'Europe/Copenhagen';

export function operatorTimezone(): string {
  return tryConfig()?.global.timezone ?? FALLBACK_TIMEZONE;
}

export function globalConfig(): GlobalConfig | null {
  return tryConfig()?.global ?? null;
}

export function baseUrl(): string {
  try {
    return publicBaseUrl();
  } catch {
    return (process.env.PROBE_PUBLIC_URL ?? '').replace(/\/+$/, '');
  }
}
