// Step 6 of the cascade (§8.3): the paid lookup, and only ever the last one.
//
// Two guards, both load bearing. Without FINDYMAIL_KEY the step does not
// exist at all: there is no silent fallback to a paid provider. With a key,
// the monthly cap from probe.toml is reserved BEFORE the call is made, not
// counted after it, so the worst case is one wasted counter increment rather
// than an unbounded bill.
//
// §13 M2 is explicit that this step should not be reached at all until the
// free steps have been measured. It exists so the cascade is complete, not
// because it is expected to run.

import { loadConfig, loadEnv, logger } from '@probe/config';
import { bumpCounter } from '@probe/db';
import type { ContactHit } from '../types';
import { postJson } from '../lib/http';
import { acceptAddress, firstNameFrom } from './extract';
import { hasMailExchanger } from './mx';

const log = logger('contact.findymail');

const ENDPOINT = 'https://app.findymail.com/api/search/domain';

export const FINDYMAIL_CONFIDENCE = 70;

interface FindymailContact {
  email?: string | null;
  name?: string | null;
}

interface FindymailResponse {
  contact?: FindymailContact | null;
  contacts?: FindymailContact[] | null;
}

/** Year and month, so the cap resets on its own and the counter for a past
 *  month stays readable. */
export function monthKey(now: Date = new Date()): string {
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `paid_lookup:${year}-${month}`;
}

function findymailKey(): string | undefined {
  try {
    return loadEnv().FINDYMAIL_KEY;
  } catch {
    return process.env.FINDYMAIL_KEY || undefined;
  }
}

export function isEnabled(): boolean {
  return Boolean(findymailKey());
}

/** Takes one unit of the monthly budget, or reports that the cap is reached.
 *  The increment happens first and is given back when it would have gone over
 *  the cap, so two leads resolving at the same time can never both think they
 *  had the last slot. */
async function reserveLookup(cap: number, now: Date): Promise<boolean> {
  const key = monthKey(now);
  const used = await bumpCounter(key, 1);
  if (used <= cap) return true;
  await bumpCounter(key, -1);
  log.warn('paid lookup blocked by monthly cap', { key, cap, used: used - 1 });
  return false;
}

/** The provider returns a full name. Only the given name reaches a generator
 *  (§6), and only when it is a plain word. */
function firstNameOfFullName(full: string | null | undefined): string | null {
  const first = (full ?? '').trim().split(/\s+/)[0] ?? '';
  if (!/^[A-Za-z][a-z'-]{1,14}$/.test(first)) return null;
  return first.charAt(0).toUpperCase() + first.slice(1);
}

export async function findFromFindymail(
  domain: string,
  opts: { now?: Date } = {},
): Promise<ContactHit | null> {
  const key = findymailKey();
  if (!key) return null;
  if (!domain) return null;

  const cap = loadConfig().global.paid_lookup_monthly_cap;
  if (cap <= 0) {
    log.warn('paid lookups disabled by config', { cap });
    return null;
  }
  if (!(await reserveLookup(cap, opts.now ?? new Date()))) return null;

  const res = await postJson(ENDPOINT, JSON.stringify({ domain }), {
    timeoutMs: 20_000,
    headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
  });
  if (!res.ok) {
    log.warn('findymail lookup failed', { domain, status: res.status, error: res.error });
    return null;
  }

  let parsed: FindymailResponse;
  try {
    parsed = JSON.parse(res.text) as FindymailResponse;
  } catch {
    log.warn('findymail returned invalid json', { domain });
    return null;
  }

  const contact = parsed.contact ?? parsed.contacts?.[0] ?? null;
  const raw = (contact?.email ?? '').trim();
  if (!raw) return null;

  const norm = acceptAddress(raw);
  if (!norm) return null;
  const host = norm.slice(norm.lastIndexOf('@') + 1);
  if (!(await hasMailExchanger(host))) return null;

  log.info('paid lookup spent', { domain });
  return {
    email: raw,
    first_name: firstNameOfFullName(contact?.name) ?? firstNameFrom([], norm),
    method: 'findymail',
    confidence: FINDYMAIL_CONFIDENCE,
  };
}
