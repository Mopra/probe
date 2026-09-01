// Step 4 of the cascade (§8.3): security.txt and humans.txt.
//
// Rare, but when it is there it is unambiguous: a `Contact:` field in a
// security.txt is an address the owner published specifically so strangers
// can reach them. Confidence is 60 rather than higher because the address is
// often a security alias rather than the founder, and isRoleAddress rejects
// most of those anyway.

import { logger } from '@probe/config';
import type { ContactHit } from '../types';
import { acceptAddress, firstNameFrom } from './extract';
import { hasMailExchanger } from './mx';
import { getPage, pathOn } from './pages';

const log = logger('contact.well_known');

export const WELL_KNOWN_PATHS = ['/.well-known/security.txt', '/security.txt', '/humans.txt'];
export const WELL_KNOWN_CONFIDENCE = 60;

/** RFC 9116 `Contact:` fields, mailto values only. A `Contact:` pointing at a
 *  web form or a phone number is a real contact channel and not one probe can
 *  use, so it is skipped rather than mangled into an address. */
export function parseContactFields(body: string): string[] {
  if (!body) return [];
  const out: string[] = [];
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^contact\s*:\s*(.+)$/i.exec(line);
    if (!m) continue;
    const value = (m[1] ?? '').trim();
    if (!/^mailto:/i.test(value)) continue;
    const address = value.slice('mailto:'.length).split(/[\s,;<>]/)[0]?.trim() ?? '';
    if (address) out.push(address);
  }
  return out;
}

export async function findFromWellKnown(baseUrl: string): Promise<ContactHit | null> {
  for (const path of WELL_KNOWN_PATHS) {
    const url = pathOn(baseUrl, path);
    if (!url) continue;
    const page = await getPage(url);
    if (!page.ok || !page.html) continue;

    // A single page application answers 200 with its index.html for every
    // unknown path. A security.txt that is HTML is that, not a security.txt.
    if (/<\s*html/i.test(page.html.slice(0, 400))) continue;

    for (const raw of parseContactFields(page.html)) {
      const norm = acceptAddress(raw);
      if (!norm) continue;
      const domain = norm.slice(norm.lastIndexOf('@') + 1);
      if (!(await hasMailExchanger(domain))) continue;
      log.debug('address found in well-known file', { url });
      return {
        email: raw,
        first_name: firstNameFrom([], norm),
        method: 'security_txt',
        confidence: WELL_KNOWN_CONFIDENCE,
      };
    }
  }
  return null;
}
