// Domain normalisation is what makes leads_domain_uniq do its job (§8.1): the
// same product launching on three directories must collapse to one lead, so
// this has to be strict and deterministic.

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

const TRACKING_PARAMS = new Set([
  'ref',
  'fbclid',
  'gclid',
  'msclkid',
  'yclid',
  'igshid',
  'mc_cid',
  'mc_eid',
  'ref_src',
  'ref_url',
  '_hsenc',
  '_hsmi',
]);

function parse(input: string): URL | null {
  if (typeof input !== 'string') return null;
  const raw = input.trim();
  if (raw.length === 0) return null;
  if (/\s/.test(raw)) return null;

  let candidate = raw;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(candidate)) {
    // Directories hand us bare hosts often enough that refusing them would
    // throw away real leads. Everything else must declare its scheme.
    candidate = `https://${candidate}`;
  }

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  return url;
}

function hostToDomain(hostname: string): string | null {
  let host = hostname.toLowerCase();
  // A fully qualified 'exit1.dev.' and 'exit1.dev' are the same host.
  while (host.endsWith('.')) host = host.slice(0, -1);
  if (host.startsWith('www.')) host = host.slice(4);
  if (host.length === 0) return null;

  // IP literals are never a product domain and would poison the dedup index.
  if (IPV4.test(host)) return null;
  if (host.startsWith('[') || host.includes(':')) return null;

  // No dot means 'localhost' or a scrape artefact.
  if (!host.includes('.')) return null;
  if (host.includes('..')) return null;

  for (const label of host.split('.')) {
    if (label.length === 0 || label.length > 63) return null;
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(label)) return null;
  }
  const tld = host.slice(host.lastIndexOf('.') + 1);
  if (tld.length < 2 || /[0-9]/.test(tld)) return null;

  return host;
}

/**
 * Lowercase host, strip 'www.', drop port, path, query and fragment.
 * Returns null when the input is not an http(s) URL with a real host.
 */
export function normalizeDomain(input: string): string | null {
  const url = parse(input);
  if (!url) return null;
  return hostToDomain(url.hostname);
}

/**
 * Canonical https URL for a lead: scheme forced to https, host normalized,
 * path preserved, tracking query params dropped. Null when unusable.
 *
 * The fragment is dropped: it never reaches the server, so it cannot be part
 * of the identity of a page we are about to probe.
 */
export function normalizeUrl(input: string): string | null {
  const url = parse(input);
  if (!url) return null;
  const domain = hostToDomain(url.hostname);
  if (!domain) return null;

  const keep: Array<[string, string]> = [];
  for (const [key, value] of url.searchParams.entries()) {
    const k = key.toLowerCase();
    if (k.startsWith('utm_')) continue;
    if (TRACKING_PARAMS.has(k)) continue;
    keep.push([key, value]);
  }

  let path = url.pathname;
  if (path === '' || path === '/') {
    // A bare root is written without its trailing slash so the same site does
    // not appear twice.
    path = '';
  }

  let query = '';
  if (keep.length > 0) {
    const params = new URLSearchParams();
    for (const [key, value] of keep) params.append(key, value);
    query = `?${params.toString()}`;
  }

  return `https://${domain}${path}${query}`;
}

/** True only when the input itself declares https. */
export function isHttps(input: string): boolean {
  if (typeof input !== 'string') return false;
  const raw = input.trim();
  if (!/^https:\/\//i.test(raw)) return false;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && hostToDomain(url.hostname) !== null;
  } catch {
    return false;
  }
}
