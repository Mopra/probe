import { describe, expect, it } from 'vitest';
import {
  checkDeliverability,
  decideDeliverability,
  lookupDomainDns,
  mailDomainOf,
  type DnsResolver,
  type DomainDns,
} from './deliverability';

function dns(over: Partial<DomainDns> = {}): DomainDns {
  return { mx: 'empty', a: 'empty', aaaa: 'empty', ...over };
}

/** A resolver whose three lookups either return one record, return nothing, or
 *  throw with a given code. */
function resolver(spec: {
  mx?: 'records' | 'empty' | string;
  a?: 'records' | 'empty' | string;
  aaaa?: 'records' | 'empty' | string;
}): DnsResolver {
  const answer = (mode: string | undefined) => async () => {
    if (mode === 'records') return [{}];
    if (mode === 'empty' || mode === undefined) return [];
    const err = new Error(mode) as Error & { code: string };
    err.code = mode;
    throw err;
  };
  return {
    resolveMx: answer(spec.mx),
    resolve4: answer(spec.a),
    resolve6: answer(spec.aaaa),
  };
}

describe('decideDeliverability', () => {
  it('an MX record is enough', () => {
    expect(decideDeliverability(dns({ mx: 'records' }))).toBe('deliverable');
  });

  it('accepts an A or AAAA record with no MX, per the implicit MX rule', () => {
    // RFC 5321 §5.1. Small self hosted setups still rely on it and they are
    // exactly the kind of lead probe is looking for.
    expect(decideDeliverability(dns({ a: 'records' }))).toBe('deliverable');
    expect(decideDeliverability(dns({ aaaa: 'records' }))).toBe('deliverable');
  });

  it('is undeliverable only when all three answered and all three were empty', () => {
    expect(decideDeliverability(dns())).toBe('undeliverable');
  });

  it('is unknown when any lookup failed to answer and nothing positive was found', () => {
    // The distinction the whole gate rests on: a resolver that timed out has
    // told us nothing, and must never cost a lead its drop_reason.
    expect(decideDeliverability(dns({ mx: 'error' }))).toBe('unknown');
    expect(decideDeliverability(dns({ a: 'error' }))).toBe('unknown');
    expect(decideDeliverability(dns({ aaaa: 'error' }))).toBe('unknown');
  });

  it('prefers a positive answer over a failed one', () => {
    // A dead resolve6 alongside a live MX is still deliverable: we have the
    // answer we needed, so the failure does not matter.
    expect(decideDeliverability(dns({ mx: 'records', aaaa: 'error' }))).toBe('deliverable');
    expect(decideDeliverability(dns({ mx: 'error', a: 'records' }))).toBe('deliverable');
  });
});

describe('lookupDomainDns', () => {
  it('reads NXDOMAIN and NODATA as a definitive empty', async () => {
    expect(await lookupDomainDns('x.test', resolver({ mx: 'ENOTFOUND' }))).toEqual(dns());
    expect(await lookupDomainDns('x.test', resolver({ mx: 'ENODATA' }))).toEqual(dns());
  });

  it('reads every other resolver failure as an unanswered question', async () => {
    const out = await lookupDomainDns('x.test', resolver({ mx: 'ETIMEOUT', a: 'ESERVFAIL' }));
    expect(out).toEqual({ mx: 'error', a: 'error', aaaa: 'empty' });
  });

  it('reads an error with no code at all as unanswered', async () => {
    const broken: DnsResolver = {
      resolveMx: async () => {
        throw new Error('socket hang up');
      },
      resolve4: async () => [],
      resolve6: async () => [],
    };
    expect(await lookupDomainDns('x.test', broken)).toEqual(dns({ mx: 'error' }));
  });

  it('reads an empty record array as empty, not as records', async () => {
    expect(await lookupDomainDns('x.test', resolver({}))).toEqual(dns());
  });
});

describe('checkDeliverability', () => {
  it('refuses a domain that cannot receive mail without asking DNS', async () => {
    // No resolver is passed, so any lookup at all would hit the network and
    // these would not be synchronous refusals.
    for (const bad of ['', 'localhost', '.example.com', 'example.com.', 'a..b.com', 'a b.com']) {
      expect(await checkDeliverability(bad)).toBe('undeliverable');
    }
  });

  it('lowercases and trims before looking anything up', async () => {
    const seen: string[] = [];
    const spy: DnsResolver = {
      resolveMx: async (d) => {
        seen.push(d);
        return [{}];
      },
      resolve4: async () => [],
      resolve6: async () => [],
    };
    expect(await checkDeliverability('  MeterBase.DEV  ', spy)).toBe('deliverable');
    expect(seen).toEqual(['meterbase.dev']);
  });

  it('returns the verdict for the evidence found', async () => {
    expect(await checkDeliverability('a.test', resolver({ mx: 'records' }))).toBe('deliverable');
    expect(await checkDeliverability('a.test', resolver({ mx: 'ENOTFOUND' }))).toBe(
      'undeliverable',
    );
    expect(await checkDeliverability('a.test', resolver({ mx: 'ETIMEOUT' }))).toBe('unknown');
  });
});

describe('mailDomainOf', () => {
  it('takes the host from a normalised address', () => {
    expect(mailDomainOf('priya@meterbase.dev')).toBe('meterbase.dev');
    expect(mailDomainOf('a@b@meterbase.dev')).toBe('meterbase.dev');
    expect(mailDomainOf('PRIYA@MeterBase.dev')).toBe('meterbase.dev');
  });

  it('is null for anything that is not an address with a host', () => {
    // The suppression scrub nulls `email` and `email_norm` (§9), so the gate
    // has to cope with a row that carries neither.
    expect(mailDomainOf(null)).toBeNull();
    expect(mailDomainOf(undefined)).toBeNull();
    expect(mailDomainOf('')).toBeNull();
    expect(mailDomainOf('priya')).toBeNull();
    expect(mailDomainOf('@meterbase.dev')).toBeNull();
    expect(mailDomainOf('priya@localhost')).toBeNull();
  });
});
