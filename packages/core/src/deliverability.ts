// Domain deliverability: the resolve-time check of §8.3, and the fifth
// approval gate of §8.5.
//
// **MX only, and never SMTP `RCPT TO`.** §8.3 forbids per-mailbox probing for
// two reasons that have not changed: catch-all configurations make the answer
// meaningless, and the probing itself damages the sending reputation this is
// meant to protect (§5.5). So what this module can prove is deliberately
// narrow. It cannot tell you a mailbox exists. It can tell you whether the
// domain still accepts mail at all, which is the difference between a typo'd
// or dead domain and a hard bounce against a new reputation.
//
// The decision is pure and the lookups are behind `DnsResolver`, which keeps
// @probe/core testable with no network and lets both approval paths reach the
// same verdict from the same evidence.
//
// The three-way answer is the whole point. A resolver that timed out has told
// us nothing, and reporting that as undeliverable would drop a live lead on a
// network hiccup, so `unknown` is a distinct verdict and callers are expected
// to leave the work exactly where it was.

import { promises as dns } from 'node:dns';

export type DnsAnswer = 'records' | 'empty' | 'error';

/** What the three lookups said. `empty` is a definitive "no such name" or "no
 *  such record"; `error` is everything else, and means the question was never
 *  answered. */
export interface DomainDns {
  mx: DnsAnswer;
  a: DnsAnswer;
  aaaa: DnsAnswer;
}

export type Deliverability = 'deliverable' | 'undeliverable' | 'unknown';

/** Resolver shape, satisfied by `node:dns`'s promises API. Only the record
 *  count is ever read, so a test double can return empty objects. */
export interface DnsResolver {
  resolveMx(domain: string): Promise<unknown[]>;
  resolve4(domain: string): Promise<unknown[]>;
  resolve6(domain: string): Promise<unknown[]>;
}

/** NXDOMAIN and NODATA. Anything else the resolver throws is a failure to
 *  answer, not an answer of "no". */
const DEFINITIVE_CODES = new Set(['ENOTFOUND', 'ENODATA', 'NXDOMAIN', 'NOTFOUND']);

function classify(err: unknown): DnsAnswer {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && DEFINITIVE_CODES.has(code) ? 'empty' : 'error';
}

async function answer(lookup: () => Promise<unknown[]>): Promise<DnsAnswer> {
  try {
    const records = await lookup();
    return records.length > 0 ? 'records' : 'empty';
  } catch (err) {
    return classify(err);
  }
}

/** Pure. Exported so the policy can be tested without a resolver at all. */
export function decideDeliverability(dns: DomainDns): Deliverability {
  if (dns.mx === 'records') return 'deliverable';

  // No MX but an address record still receives mail: the implicit MX rule of
  // RFC 5321 §5.1 is old, but a few small self hosted setups still rely on it,
  // and rejecting them would lose exactly the kind of founder probe is looking
  // for.
  if (dns.a === 'records' || dns.aaaa === 'records') return 'deliverable';

  // Nothing positive was found, so an unanswered question decides it. Erring
  // towards `unknown` costs a retry; erring the other way drops a real lead.
  if (dns.mx === 'error' || dns.a === 'error' || dns.aaaa === 'error') return 'unknown';

  return 'undeliverable';
}

/** Syntactically incapable of receiving mail, decided without a lookup. */
function hopeless(domain: string): boolean {
  return (
    !domain ||
    !domain.includes('.') ||
    domain.startsWith('.') ||
    domain.endsWith('.') ||
    domain.includes('..') ||
    domain.includes('@') ||
    /\s/.test(domain)
  );
}

/** The host part of an already normalised address, or null. */
export function mailDomainOf(emailNorm: string | null | undefined): string | null {
  const at = (emailNorm ?? '').lastIndexOf('@');
  if (at < 1) return null;
  const domain = emailNorm!.slice(at + 1).trim().toLowerCase();
  return domain.includes('.') ? domain : null;
}

/** All three lookups at once: one round trip instead of up to three, and the
 *  complete evidence for the log line either way. */
export async function lookupDomainDns(
  domain: string,
  resolver: DnsResolver = dns,
): Promise<DomainDns> {
  const [mx, a, aaaa] = await Promise.all([
    answer(() => resolver.resolveMx(domain)),
    answer(() => resolver.resolve4(domain)),
    answer(() => resolver.resolve6(domain)),
  ]);
  return { mx, a, aaaa };
}

/** Can this domain still receive mail? Uncached on purpose: the caller owns
 *  any caching, because a resolve pass wants one answer per run and an
 *  approval gate exists precisely to ask again. */
export async function checkDeliverability(
  domain: string,
  resolver?: DnsResolver,
): Promise<Deliverability> {
  const key = (domain ?? '').trim().toLowerCase();
  if (hopeless(key)) return 'undeliverable';
  return decideDeliverability(await lookupDomainDns(key, resolver));
}
