// Step 3 of the cascade (§8.3): a Product Hunt maker's personal site.
//
// The maker profile itself carries no address, but it usually carries a link
// to a personal site, and a personal site is step 1 again with a different
// base URL. Confidence is 70 rather than 90 because the address belongs to
// the person's own domain, not to the product's, so the link between the
// address and the launch is one hop longer.
//
// Note that leads do not currently persist the maker link: NewLead (§7) has
// no column for it, so this step only fires when the caller hands the URL in
// through resolveContact's opts. That is a real gap for product_hunt leads
// and it is an M7 concern, not something to fake with a lookup here.

import type { ContactHit } from '../types';
import { scanSite } from './mailto';

export const PH_MAKER_CONFIDENCE = 70;

export async function findFromMakerSite(websiteUrl: string): Promise<ContactHit | null> {
  const hit = await scanSite(websiteUrl, { leadDomain: null, method: 'ph_maker' });
  if (!hit) return null;
  return { ...hit, method: 'ph_maker', confidence: PH_MAKER_CONFIDENCE };
}
