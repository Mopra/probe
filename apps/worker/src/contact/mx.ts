// Deliverability check for a resolved address (§8.3).
//
// The lookups and the verdict live in @probe/core so that this pass and the
// §8.5 approval gate cannot disagree. What stays here is the per-run cache:
// one resolve pass asks about the same handful of hosts repeatedly and should
// only pay for each once. The approval gate deliberately does NOT come through
// here, because a cached answer is the one thing that gate is not allowed to
// have.
//
// MX only. §8.3 forbids SMTP `RCPT TO` verification: catch-all configurations
// make the answer meaningless and the probing itself hurts the sending
// reputation we are trying to build (§5.5). An MX record is a cheap, passive
// way to reject a typo'd or long dead domain before it becomes a hard bounce.

import { checkDeliverability, type Deliverability } from '@probe/core';
import { logger } from '@probe/config';

const log = logger('contact.mx');

const cache = new Map<string, Promise<Deliverability>>();

export function clearMxCache(): void {
  cache.clear();
}

/**
 * True when the domain can plausibly receive mail. Cached for the run.
 *
 * `unknown` counts as false, which is the behaviour this check has always had:
 * a resolver that would not answer is not grounds for spending a generator
 * call, and the lead comes back around on a later pass as `no_contact` rather
 * than being mailed on a guess. The approval gate treats the same verdict
 * differently, and says why.
 */
export function hasMailExchanger(domain: string): Promise<boolean> {
  const key = (domain ?? '').trim().toLowerCase();
  if (!key || !key.includes('.')) return Promise.resolve(false);

  const hit = cache.get(key);
  if (hit) return hit.then((v) => v === 'deliverable');

  const pending = checkDeliverability(key).then((verdict) => {
    if (verdict !== 'deliverable') log.debug('no mail exchanger', { domain: key, verdict });
    return verdict;
  });
  cache.set(key, pending);
  return pending.then((v) => v === 'deliverable');
}
