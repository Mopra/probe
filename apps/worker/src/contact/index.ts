// The §8.3 cascade, in order, stopping at the first hit.
//
// The order is the design: free before paid, the founder's own domain before
// anybody else's, and the paid provider last and capped. Each step is
// isolated, because a step that throws is a broken website rather than a
// verdict on the lead, and the next step deserves its turn.

import { logger } from '@probe/config';
import type { LeadRow } from '@probe/db';
import type { ContactHit } from '../types';
import { findFromFindymail, isEnabled as findymailEnabled } from './findymail';
import { findFromHnProfile, handleFromProfileUrl, isHnProfileUrl } from './hn-profile';
import { findOnLeadSite } from './mailto';
import { findFromMakerSite } from './ph-maker';
import { findFromWellKnown } from './well-known';
import { findFromRdap } from './whois';

const log = logger('contact');

export interface ResolveContactOptions {
  /** The submitter link the sweep saw. An HN profile URL feeds step 2; any
   *  other site is treated as a maker's personal site and feeds step 3. */
  submitterProfileUrl?: string | null;
}

async function step(
  name: string,
  leadId: string,
  fn: () => Promise<ContactHit | null>,
): Promise<ContactHit | null> {
  try {
    return await fn();
  } catch (err) {
    log.warn('cascade step failed', {
      step: name,
      lead_id: leadId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

export async function resolveContact(
  lead: LeadRow,
  opts: ResolveContactOptions,
): Promise<ContactHit | null> {
  const submitter = (opts.submitterProfileUrl ?? '').trim();
  const hnHandle = submitter && isHnProfileUrl(submitter) ? handleFromProfileUrl(submitter) : null;
  const makerSite = submitter && !isHnProfileUrl(submitter) ? submitter : null;

  // 1. The product's own pages.
  const own = await step('mailto', lead.id, () => findOnLeadSite(lead.url, lead.domain));
  if (own) return own;

  // 2. The Show HN submitter's profile.
  if (hnHandle) {
    const hn = await step('hn_profile', lead.id, () => findFromHnProfile(hnHandle));
    if (hn) return hn;
  }

  // 3. A Product Hunt maker's personal site, which is step 1 again.
  if (makerSite) {
    const maker = await step('ph_maker', lead.id, () => findFromMakerSite(makerSite));
    if (maker) return maker;
  }

  // 4. security.txt and humans.txt.
  const wellKnown = await step('security_txt', lead.id, () => findFromWellKnown(lead.url));
  if (wellKnown) return wellKnown;

  // 5. Registration data, when it is not privacy shielded.
  const rdap = await step('whois', lead.id, () => findFromRdap(lead.domain));
  if (rdap) return rdap;

  // 6. The paid lookup. Absent without a key, capped with one.
  if (findymailEnabled()) {
    const paid = await step('findymail', lead.id, () => findFromFindymail(lead.domain));
    if (paid) return paid;
  }

  log.debug('cascade found nothing', { lead_id: lead.id, domain: lead.domain });
  return null;
}

export { clearPageCache } from './pages';
export { clearMxCache } from './mx';
export { fetchHnProfile } from './hn-profile';
export { fetchRdap } from './whois';
