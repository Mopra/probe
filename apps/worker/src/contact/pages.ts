// Page fetching for the contact cascade, with a per-run cache.
//
// jobs/resolve.ts reads the landing page, /imprint, /legal and /contact for
// the jurisdiction guess (§8.2) and then the cascade reads the same pages
// again for addresses (§8.3). Fetching a stranger's site twice in one minute
// is rude and slow, so every read goes through here and the second one is
// free. The cache lives for one run and is cleared at the top of it.

import { load } from 'cheerio';
import { logger } from '@probe/config';
import { fetchText } from '../lib/http';

const log = logger('contact.pages');

export interface Page {
  /** The URL after redirects, which is what an address on the page belongs to. */
  url: string;
  requestedUrl: string;
  ok: boolean;
  status: number;
  html: string;
}

/** A morning's leads are a few hundred pages at most, and the process is a
 *  cron job that exits. The cap is here so a pathological run cannot grow the
 *  heap without bound, not because eviction is expected. */
const MAX_ENTRIES = 2_000;

const cache = new Map<string, Promise<Page>>();

export function clearPageCache(): void {
  cache.clear();
}

export function getPage(url: string): Promise<Page> {
  const key = url;
  const hit = cache.get(key);
  if (hit) return hit;

  const pending = fetchText(url).then((res) => ({
    url: res.url || url,
    requestedUrl: url,
    ok: res.ok,
    status: res.status,
    html: res.text,
  }));

  if (cache.size < MAX_ENTRIES) cache.set(key, pending);
  return pending;
}

/** Absolute URL for a path on the same origin, or null when the base is not a
 *  usable http(s) URL. */
export function pathOn(baseUrl: string, path: string): string | null {
  try {
    const base = new URL(baseUrl);
    if (base.protocol !== 'http:' && base.protocol !== 'https:') return null;
    return new URL(path, `${base.protocol}//${base.host}`).toString();
  } catch {
    return null;
  }
}

/** Visible text only. Script and style bodies are full of things that look
 *  like addresses (Sentry DSNs above all) and are never a founder's inbox. */
export function pageText(html: string): string {
  if (!html) return '';
  try {
    const $ = load(html);
    $('script, style, noscript, svg').remove();
    // Separators before flattening, so 'Priya' in one tag and 'Founder' in
    // the next do not arrive as one word and defeat every pattern that reads
    // a name or an address out of the surrounding text.
    $('p, br, div, li, tr, td, h1, h2, h3, h4, h5, h6, section, article, footer, header').after(' ');
    return $('body').text().replace(/\s+/g, ' ').trim() || $.root().text().replace(/\s+/g, ' ').trim();
  } catch (err) {
    log.debug('page parse failed', { error: err instanceof Error ? err.message : String(err) });
    return '';
  }
}
