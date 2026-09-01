// Env and config reads that must not explode when neither is fully present.
//
// The dry-run harness (§13 M0) is the thing Morten lives in for two weeks and
// it has to work on a laptop with no .env and no database. loadEnv() throws
// when a worker-only secret is missing, which is correct for every job that
// touches Postgres and wrong for a harness that touches nothing. These helpers
// draw the line in one place.

import { loadConfig, loadEnv, publicBaseUrl } from '@probe/config';

/**
 * §3.1 rule 4 and §5.5. Dry-run is the default and this is the single question
 * that decides whether the process can email a stranger.
 *
 * Fails closed: a broken or absent env is not a licence to send. loadEnv()
 * parses only the literal string 'true' as true, so 'TRUE', '1' and 'yes' all
 * land in dry-run.
 */
export function sendEnabled(): boolean {
  try {
    return loadEnv().PROBE_SEND_ENABLED === true;
  } catch {
    return false;
  }
}

/** Where the dry-run sender and the harness write .eml files. */
export function outboxDir(): string {
  try {
    return loadEnv().PROBE_OUTBOX_DIR;
  } catch {
    const raw = process.env.PROBE_OUTBOX_DIR?.trim();
    return raw && raw.length > 0 ? raw : './outbox';
  }
}

/** Base for /u, /c and /data links. publicBaseUrl() reads probe.toml, so this
 *  works without any env at all; the try is belt and braces. */
export function baseUrl(): string {
  try {
    return publicBaseUrl();
  } catch {
    return loadConfig().global.public_base_url.replace(/\/+$/, '');
  }
}

/** CAN-SPAM physical postal address for the footer (§9.2.7). */
export function postalAddress(): string {
  return loadConfig().global.postal_address;
}

/** Who an approval is recorded as. Defaulted by the loader. */
export function approver(): string {
  try {
    return loadEnv().PROBE_APPROVER;
  } catch {
    const raw = process.env.PROBE_APPROVER?.trim();
    return raw && raw.length > 0 ? raw : 'morten';
  }
}
