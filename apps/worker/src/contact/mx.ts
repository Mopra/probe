// Deliverability check for a resolved address (§8.3).
//
// MX only. §8.3 forbids SMTP `RCPT TO` verification: catch-all configurations
// make the answer meaningless and the probing itself hurts the sending
// reputation we are trying to build (§5.5). An MX record is a cheap, passive
// way to reject a typo'd or long dead domain before it becomes a hard bounce.

import { promises as dns } from 'node:dns';
import { logger } from '@probe/config';

const log = logger('contact.mx');

const cache = new Map<string, Promise<boolean>>();

export function clearMxCache(): void {
  cache.clear();
}

async function lookup(domain: string): Promise<boolean> {
  try {
    const records = await dns.resolveMx(domain);
    if (records.length > 0) return true;
  } catch {
    // NXDOMAIN and NODATA both land here. Fall through to the A record.
  }

  // A domain with no MX but an A record still receives mail: the implicit MX
  // rule from RFC 5321 §5.1 is old, but a few small self hosted setups still
  // rely on it, and rejecting them would lose exactly the kind of founder
  // this tool is looking for.
  try {
    const a = await dns.resolve4(domain);
    if (a.length > 0) return true;
  } catch {
    // ignored, checked below
  }
  try {
    const aaaa = await dns.resolve6(domain);
    return aaaa.length > 0;
  } catch {
    return false;
  }
}

/** True when the domain can plausibly receive mail. Cached for the run. */
export function hasMailExchanger(domain: string): Promise<boolean> {
  const key = domain.toLowerCase();
  if (!key || !key.includes('.')) return Promise.resolve(false);
  const hit = cache.get(key);
  if (hit) return hit;

  const pending = lookup(key).then((ok) => {
    if (!ok) log.debug('no mail exchanger', { domain: key });
    return ok;
  });
  cache.set(key, pending);
  return pending;
}
