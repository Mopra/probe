// Step 1 of the cascade (§8.3): the product's own pages.
//
// This is the step that should carry the whole thing. It is free, it is the
// most honest provenance line the email can carry ("I found your address on
// your /contact page", §9.2.4), and an address a founder published on their
// own site is an address they expect to receive mail on.

import { logger } from '@probe/config';
import type { ContactHit } from '../types';
import { extractFromHtml, firstNameFrom, rankCandidates, type RankedCandidate } from './extract';
import { hasMailExchanger } from './mx';
import { getPage, pathOn } from './pages';

const log = logger('contact.mailto');

/** The landing page first, then the pages that carry an address when the
 *  landing page does not. /imprint and /legal are here because a European
 *  founder is legally required to publish one, and /privacy because a data
 *  controller has to name a contact. */
export const CONTACT_PATHS = ['/contact', '/about', '/imprint', '/legal', '/privacy', '/team'];

/** Good enough to stop looking: a mailto on the product's own domain. */
const STOP_CONFIDENCE = 90;

export interface SiteScan {
  /** Best acceptable candidate, MX checked, or null. */
  hit: ContactHit | null;
  /** Pages actually fetched, so the caller can reuse the text. */
  pagesFetched: number;
}

async function firstDeliverable(
  ranked: RankedCandidate[],
  contexts: string[],
  method: string,
): Promise<ContactHit | null> {
  for (const candidate of ranked) {
    const domain = candidate.emailNorm.slice(candidate.emailNorm.lastIndexOf('@') + 1);
    if (!(await hasMailExchanger(domain))) continue;
    return {
      email: candidate.email.trim(),
      first_name: firstNameFrom([candidate.context, ...contexts], candidate.emailNorm),
      method,
      confidence: candidate.confidence,
    };
  }
  return null;
}

/** Scans a site for an address. `leadDomain` is the domain we would prefer to
 *  find the address on; pass null when scanning somebody's personal site,
 *  where any domain is equally plausible. */
export async function scanSite(
  baseUrl: string,
  opts: { leadDomain?: string | null; method?: string; paths?: string[] } = {},
): Promise<ContactHit | null> {
  const method = opts.method ?? 'mailto';
  const leadDomain = opts.leadDomain ?? null;
  const paths = opts.paths ?? CONTACT_PATHS;

  const collected: RankedCandidate[] = [];
  const contexts: string[] = [];

  const urls = [baseUrl, ...paths.map((p) => pathOn(baseUrl, p)).filter((u): u is string => Boolean(u))];

  for (const url of urls) {
    const page = await getPage(url);
    if (!page.ok || !page.html) continue;

    const ranked = rankCandidates(extractFromHtml(page.html), leadDomain);
    for (const candidate of ranked) {
      if (!collected.some((c) => c.emailNorm === candidate.emailNorm)) collected.push(candidate);
      contexts.push(candidate.context);
    }

    // A mailto on the product's own domain is the best this step can do, so
    // there is no reason to keep fetching a stranger's pages.
    const best = collected[0];
    if (best && best.ownDomain && best.confidence >= STOP_CONFIDENCE) break;
  }

  if (collected.length === 0) return null;

  collected.sort((a, b) => {
    if (a.ownDomain !== b.ownDomain) return a.ownDomain ? -1 : 1;
    return b.confidence - a.confidence;
  });

  const hit = await firstDeliverable(collected, contexts, method);
  if (hit) log.debug('address found on site', { baseUrl, method, confidence: hit.confidence });
  return hit;
}

/** Step 1 proper: the lead's own site. */
export function findOnLeadSite(leadUrl: string, leadDomain: string): Promise<ContactHit | null> {
  return scanSite(leadUrl, { leadDomain, method: 'mailto' });
}
