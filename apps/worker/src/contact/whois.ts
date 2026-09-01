// Step 5 of the cascade (§8.3): registration data, over RDAP.
//
// RDAP rather than legacy WHOIS: it is JSON over HTTPS, it needs no extra
// dependency, and rdap.org redirects to whichever registry is authoritative
// for the TLD. §8.3 already expects this step to be a near miss most of the
// time, because privacy shielding is now the default rather than the
// exception, so the important half of this module is knowing when to say no.
//
// The record does carry one thing that is genuinely useful even when the
// address is redacted: a registrant country. That is a real jurisdiction
// signal (§8.2), and it is exported separately for jobs/resolve.ts.

import { logger } from '@probe/config';
import type { ContactHit } from '../types';
import { fetchJson } from '../lib/http';
import { acceptAddress, firstNameFrom } from './extract';
import { hasMailExchanger } from './mx';

const log = logger('contact.whois');

const RDAP_BASE = 'https://rdap.org/domain/';

/** Weakest of the free steps: the address, if there is one, belongs to
 *  whoever registered the domain and may be an agency or an accountant. */
export const RDAP_CONFIDENCE = 40;

export interface RdapResult {
  email: string | null;
  /** ISO 3166-1 alpha-2 from the registrant address, when it is not a proxy's. */
  country: string | null;
}

/** The vocabulary of a shielded record. Anything matching this is a
 *  registrar's privacy service, and both its address and its country describe
 *  the service rather than the founder. */
const PRIVACY_MARKERS =
  /redacted|privacy|whoisguard|privacyprotect|domains?\s?by\s?proxy|contact\s?privacy|withheld|anonymi[sz]e|data\s?protected|not\s?disclosed|proxy|perfect\s?privacy|identity\s?protect|statutory\s?masking|gdpr\s?masked|non-?public\s?data|obscured/i;

const PROXY_MAIL_HOSTS = [
  'whoisguard.com',
  'whoisprivacyprotect.com',
  'domainsbyproxy.com',
  'contactprivacy.com',
  'withheldforprivacy.com',
  'privacyprotect.org',
  'identity-protect.org',
  'privacyguardian.org',
  'registrar-servers.com',
  'tieredaccess.com',
  'anonymize.com',
  'njal.la',
  'gandi.net',
];

interface VcardEntry {
  name: string;
  params: Record<string, unknown>;
  value: unknown;
}

interface RdapEntity {
  roles?: string[];
  vcardArray?: unknown;
  entities?: RdapEntity[];
}

interface RdapDomain {
  entities?: RdapEntity[];
}

/** True when a value, from anywhere in the record, is privacy boilerplate. */
export function isPrivacyShielded(value: string): boolean {
  if (!value) return false;
  if (PRIVACY_MARKERS.test(value)) return true;
  const at = value.lastIndexOf('@');
  if (at !== -1) {
    const host = value.slice(at + 1).toLowerCase();
    if (PROXY_MAIL_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) return true;
  }
  return false;
}

function readVcard(vcardArray: unknown): VcardEntry[] {
  if (!Array.isArray(vcardArray) || vcardArray.length < 2) return [];
  const entries = vcardArray[1];
  if (!Array.isArray(entries)) return [];
  const out: VcardEntry[] = [];
  for (const entry of entries) {
    if (!Array.isArray(entry) || entry.length < 4) continue;
    const name = typeof entry[0] === 'string' ? entry[0].toLowerCase() : '';
    if (!name) continue;
    const params =
      entry[1] && typeof entry[1] === 'object' ? (entry[1] as Record<string, unknown>) : {};
    out.push({ name, params, value: entry[3] });
  }
  return out;
}

function flattenText(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(flattenText);
  return [];
}

function countryFromEntry(entry: VcardEntry): string | null {
  const cc = entry.params['cc'];
  if (typeof cc === 'string' && /^[A-Za-z]{2}$/.test(cc.trim())) return cc.trim().toUpperCase();
  if (Array.isArray(entry.value)) {
    // Structured vcard address: the seventh component is the country.
    const country = entry.value[6];
    if (typeof country === 'string' && /^[A-Za-z]{2}$/.test(country.trim())) {
      return country.trim().toUpperCase();
    }
  }
  return null;
}

function walkEntities(entities: RdapEntity[] | undefined, out: RdapEntity[] = []): RdapEntity[] {
  for (const entity of entities ?? []) {
    if (!entity || typeof entity !== 'object') continue;
    out.push(entity);
    walkEntities(entity.entities, out);
  }
  return out;
}

/** Pulls an address and a country out of an RDAP domain document. Returns
 *  nulls for a shielded record rather than the proxy's details, which §8.3
 *  says is now the common case. */
export function parseRdap(doc: unknown): RdapResult {
  const domain = (doc ?? {}) as RdapDomain;
  const entities = walkEntities(domain.entities);

  let email: string | null = null;
  let country: string | null = null;
  let fallbackCountry: string | null = null;

  for (const entity of entities) {
    const roles = (entity.roles ?? []).map((r) => String(r).toLowerCase());
    // A registrar's own contact block describes the registrar, never the
    // person who launched the product.
    const isRegistrar = roles.includes('registrar') || roles.includes('reseller');
    const isRegistrant = roles.includes('registrant') || roles.includes('administrative');

    const entries = readVcard(entity.vcardArray);
    if (entries.length === 0) continue;

    const shielded = entries
      .flatMap((e) => flattenText(e.value))
      .some((text) => isPrivacyShielded(text));

    if (!shielded && !isRegistrar) {
      for (const entry of entries) {
        if (entry.name !== 'email' || email) continue;
        const value = flattenText(entry.value)[0]?.trim();
        if (value && !isPrivacyShielded(value)) email = value;
      }
    }

    if (!shielded && !isRegistrar) {
      for (const entry of entries) {
        if (entry.name !== 'adr') continue;
        const found = countryFromEntry(entry);
        if (!found) continue;
        if (isRegistrant && !country) country = found;
        if (!fallbackCountry) fallbackCountry = found;
      }
    }
  }

  return { email, country: country ?? fallbackCountry };
}

/** One RDAP lookup. Never throws: a TLD with no RDAP service is an ordinary
 *  outcome, not an error worth failing a lead over. */
export async function fetchRdap(domain: string): Promise<RdapResult> {
  if (!domain) return { email: null, country: null };
  const res = await fetchJson<unknown>(`${RDAP_BASE}${encodeURIComponent(domain)}`, {
    timeoutMs: 10_000,
  });
  if (!res.ok || res.data === null) {
    log.debug('rdap lookup failed', { domain, status: res.status });
    return { email: null, country: null };
  }
  try {
    return parseRdap(res.data);
  } catch (err) {
    log.debug('rdap parse failed', { domain, error: err instanceof Error ? err.message : String(err) });
    return { email: null, country: null };
  }
}

export async function findFromRdap(domain: string): Promise<ContactHit | null> {
  const record = await fetchRdap(domain);
  if (!record.email) return null;

  const norm = acceptAddress(record.email);
  if (!norm) return null;
  const host = norm.slice(norm.lastIndexOf('@') + 1);
  if (!(await hasMailExchanger(host))) return null;

  return {
    email: record.email,
    first_name: firstNameFrom([], norm),
    method: 'whois',
    confidence: RDAP_CONFIDENCE,
  };
}
