// Step 2 of the cascade (§8.3): the Show HN submitter's own HN profile.
//
// §8.3 says the `about` field very often has an address, and it is the single
// most defensible one we can use: the founder typed it into a public profile
// on the site where they launched. The same field is also the fourth
// jurisdiction guess (§8.2), so jobs/resolve.ts reads the location from here
// before a single contact lookup is spent.

import { load } from 'cheerio';
import { logger } from '@probe/config';
import type { ContactHit } from '../types';
import { acceptAddress, deobfuscate, extractFromText, firstNameFrom, rankCandidates } from './extract';
import { hasMailExchanger } from './mx';
import { getPage } from './pages';

const log = logger('contact.hn_profile');

const HN_USER = 'https://news.ycombinator.com/user?id=';

/** §8.3 puts this second for a reason: it is weaker than an address the
 *  founder published on the product's own domain, and stronger than anything
 *  scraped out of prose. */
export const HN_PROFILE_CONFIDENCE = 80;

export interface HnProfile {
  about: string | null;
  /** The part of `about` that looks like where the person is, for
   *  countryFromLocationString. Null when nothing looks like a place. */
  location: string | null;
  email: string | null;
}

export function profileUrl(handle: string): string {
  return `${HN_USER}${encodeURIComponent(handle)}`;
}

/** True for a URL that is an HN profile rather than somebody's own site. */
export function isHnProfileUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.hostname.toLowerCase().endsWith('news.ycombinator.com') && parsed.pathname === '/user';
  } catch {
    return false;
  }
}

export function handleFromProfileUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.searchParams.get('id');
  } catch {
    return null;
  }
}

/** Pulls the `about:` cell out of an HN user page. */
export function parseAbout(html: string): string | null {
  if (!html) return null;
  try {
    const $ = load(html);
    let about: string | null = null;
    $('td').each((_i, el) => {
      if (about !== null) return;
      const label = $(el).text().replace(/\s+/g, ' ').trim().toLowerCase();
      if (label !== 'about:') return;
      const cell = $(el).next('td');
      if (cell.length === 0) return;
      const inner = (cell.html() ?? '').replace(/<\s*(?:br|\/p|p)\s*\/?>/gi, '\n');
      about = load(`<div>${inner}</div>`)
        .text()
        .split('\n')
        .map((line) => line.replace(/[ \t]+/g, ' ').trim())
        .filter((line) => line.length > 0)
        .join('\n');
    });
    return about && (about as string).length > 0 ? about : null;
  } catch {
    return null;
  }
}

/** A location-shaped line, e.g. 'Berlin, Germany' or 'SF, CA'. Falls back to
 *  the whole field: countryFromText and countryFromLocationString are
 *  conservative by contract, so handing them more text is safe. */
export function locationFromAbout(about: string | null): string | null {
  if (!about) return null;
  const cleaned = deobfuscate(about)
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/g, ' ')
    .replace(/[ \t]+/g, ' ');

  for (const line of cleaned.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length > 0 && trimmed.length <= 60 && /^[A-Za-z][A-Za-z .'-]*,\s*[A-Za-z][A-Za-z .'-]*$/.test(trimmed)) {
      return trimmed;
    }
  }

  const flat = cleaned.replace(/\s+/g, ' ').trim();
  return flat ? flat.slice(0, 200) : null;
}

export async function fetchHnProfile(handle: string): Promise<HnProfile> {
  const page = await getPage(profileUrl(handle));
  if (!page.ok || !page.html) {
    log.debug('hn profile unavailable', { handle, status: page.status });
    return { about: null, location: null, email: null };
  }

  const about = parseAbout(page.html);
  if (!about) return { about: null, location: null, email: null };

  const ranked = rankCandidates(extractFromText(about), null);
  const email = ranked[0]?.email.trim() ?? null;

  return { about, location: locationFromAbout(about), email };
}

export async function findFromHnProfile(handle: string): Promise<ContactHit | null> {
  const profile = await fetchHnProfile(handle);
  if (!profile.email) return null;

  const norm = acceptAddress(profile.email);
  if (!norm) return null;
  const domain = norm.slice(norm.lastIndexOf('@') + 1);
  if (!(await hasMailExchanger(domain))) return null;

  return {
    email: profile.email,
    first_name: firstNameFrom([profile.about ?? ''], norm),
    method: 'hn_profile',
    confidence: HN_PROFILE_CONFIDENCE,
  };
}
