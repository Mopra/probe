// Resolve, 07:00 (§8.2 and §8.3).
//
// The order of the steps in processLead is the whole point of §8.2:
// jurisdiction is settled before a single contact lookup or generator call is
// spent, matching happens before the cascade, and suppression is checked
// before and after the address is found. Nothing here may be reordered for
// convenience.

import { loadConfig, loadEnv, logger } from '@probe/config';
import {
  countryFromDomain,
  countryFromLocationString,
  countryFromText,
  hashEmail,
  isBlockedJurisdiction,
  isPlatformDomain,
  matchLead,
  normalizeDomain,
  normalizeEmail,
  resolveJurisdiction,
  type JurisdictionGuess,
  type MatchCandidate,
} from '@probe/core';
import {
  bumpCounter,
  dropLead,
  getContactForLead,
  getLead,
  hasLiveSend,
  insertContact,
  isSuppressed,
  listCampaigns,
  listLeadsByStatus,
  setLeadJurisdiction,
  setLeadStatus,
  type CampaignRow,
  type LeadRow,
} from '@probe/db';
import { clearMxCache, clearPageCache, fetchHnProfile, resolveContact } from '../contact';
import { getPage, pageText, pathOn } from '../contact/pages';
import { profileUrl } from '../contact/hn-profile';
import { fetchRdap } from '../contact/whois';
import { hnAuthorForItem } from '../sources/show-hn';
import type { ResolveSummary } from '../types';

const log = logger('job.resolve');

/** One morning's discoveries, with headroom. A cap rather than everything so
 *  a backlog cannot turn one run into an all day crawl of other people's
 *  sites. */
const BATCH_LIMIT = 500;

/** Small on purpose. These are strangers' web servers, several requests each,
 *  and a launch morning is not the time to look like a scraper. */
const CONCURRENCY = 4;

/** Pages that carry a company address when any page does. Read once here for
 *  the jurisdiction guess and served from the page cache when the cascade
 *  reads them again. */
const JURISDICTION_PATHS = ['/imprint', '/legal', '/contact'];

interface Context {
  campaigns: CampaignRow[];
  candidates: MatchCandidate[];
  blockedCountries: string[];
  pepper: string;
  summary: ResolveSummary;
  /** `cli smoke` only. Stands in for step 4, the cascade, and nothing else:
   *  the operator has named the recipient, so there is no address to discover.
   *  Every other step still runs, suppression and contact-once included, so a
   *  smoke lead reaches the queue by the same route as a swept one. */
  contactOverride?: { email: string; first_name: string | null };
}

async function siteText(lead: LeadRow): Promise<string> {
  const urls = [lead.url, ...JURISDICTION_PATHS.map((p) => pathOn(lead.url, p))].filter(
    (u): u is string => Boolean(u),
  );
  const parts: string[] = [];
  for (const url of urls) {
    const page = await getPage(url);
    if (!page.ok || !page.html) continue;
    const text = pageText(page.html);
    if (text) parts.push(text);
  }
  return parts.join('\n');
}

/** The §8.2 guesses, in priority order, evaluated lazily.
 *
 *  resolveJurisdiction takes the first non-null guess in the order it is
 *  given, so once one answers, the later lookups cannot change the outcome
 *  and are not worth a stranger's bandwidth. */
async function guessJurisdiction(
  lead: LeadRow,
  hnHandle: () => Promise<string | null>,
): Promise<{ guess: JurisdictionGuess; detail: string | null }> {
  const guesses: JurisdictionGuess[] = [];
  let detail: string | null = null;

  const tld = countryFromDomain(lead.domain);
  guesses.push({ country: tld, source: 'tld' });
  if (tld) return { guess: resolveJurisdiction(guesses), detail: `tld ${lead.domain}` };

  const rdap = await fetchRdap(lead.domain);
  guesses.push({ country: rdap.country, source: 'whois' });
  if (rdap.country) return { guess: resolveJurisdiction(guesses), detail: `rdap ${lead.domain}` };

  const text = await siteText(lead);
  const fromText = text ? countryFromText(text) : null;
  guesses.push({ country: fromText, source: 'imprint' });
  if (fromText) return { guess: resolveJurisdiction(guesses), detail: 'site text' };

  if (lead.source_id === 'show_hn') {
    const handle = await hnHandle();
    if (handle) {
      const profile = await fetchHnProfile(handle);
      const fromLocation = profile.location ? countryFromLocationString(profile.location) : null;
      guesses.push({ country: fromLocation, source: 'hn_profile' });
      if (fromLocation) detail = `hn profile ${handle}`;
    }
  }

  return { guess: resolveJurisdiction(guesses), detail };
}

/**
 * The campaigns matching may route to. Paused ones stay in: pausing gates
 * sending, not routing, and a paused campaign's queue is meant to keep filling.
 *
 * `routable = false` is the other thing, and it exists because `day3` had no
 * way to say what was true of it: its generator does not exist, so half of
 * every intake was round-robined into 404s.
 */
function routable(campaigns: CampaignRow[]): CampaignRow[] {
  const open = campaigns.filter((c) => c.routable);
  if (open.length === 0) {
    // Better a loud empty pass than silently routing to a campaign that was
    // switched off on purpose.
    log.error('no routable campaigns, every lead will drop as no_match', {
      campaigns: campaigns.map((c) => c.slug),
    });
  }
  return open;
}

async function processLead(lead: LeadRow, ctx: Context): Promise<void> {
  const leadLog = log.child({ lead_id: lead.id, domain: lead.domain });

  let cachedHandle: string | null | undefined;
  const hnHandle = async (): Promise<string | null> => {
    if (cachedHandle !== undefined) return cachedHandle;
    cachedHandle = lead.source_id === 'show_hn' ? await hnAuthorForItem(lead.external_id) : null;
    return cachedHandle;
  };

  // 0. A platform domain is not a product. Cheapest possible check, and it
  //    runs before the jurisdiction lookups because there is no answer those
  //    could give that would make github.com worth an email. Leads swept
  //    before the denylist existed reach this and are dropped here.
  if (isPlatformDomain(lead.domain)) {
    await dropLead(lead.id, 'platform_domain');
    ctx.summary.platform_domain += 1;
    leadLog.info('platform domain, not a product', { domain: lead.domain });
    return;
  }

  // 1. Jurisdiction, before anything else is spent. Recorded either way
  //    (§8.2), then gated against the blocklist. A country we could not
  //    establish passes: unknown is contactable now, which is the trade the
  //    blocklist makes and the reason the recorded value still matters.
  const { guess, detail } = await guessJurisdiction(lead, hnHandle);
  await setLeadJurisdiction(lead.id, { country: guess.country, source: guess.source, detail });

  if (isBlockedJurisdiction(guess.country, ctx.blockedCountries)) {
    await dropLead(lead.id, 'jurisdiction_blocked');
    ctx.summary.jurisdiction_blocked += 1;
    leadLog.info('jurisdiction blocked', { country: guess.country, source: guess.source });
    return;
  }

  // 2. Match, against the campaigns in the database rather than the file
  //    (§11: everything at runtime reads the table). Paused campaigns are
  //    still candidates: pausing gates sending, not routing.
  const rrCounter = await bumpCounter('match_rr');
  const match = matchLead({
    lead: { name: lead.name, url: lead.url, description: lead.description, tags: lead.tags },
    candidates: ctx.candidates,
    rrCounter,
  });
  const campaign = match.slug ? ctx.campaigns.find((c) => c.slug === match.slug) ?? null : null;
  if (!campaign) {
    await dropLead(lead.id, 'no_match');
    ctx.summary.no_match += 1;
    leadLog.debug('no match', { reason: match.reason, detail: match.detail });
    return;
  }
  await setLeadStatus(lead.id, 'matched', campaign.id);
  ctx.summary.matched += 1;

  // 3. Suppression before the cascade (§8.3): never spend a generator call,
  //    or a paid lookup, on someone already suppressed. An address that has
  //    not been found yet cannot be hashed, so this only catches a contact
  //    already known for the lead. The real check is step 5.
  const known = await getContactForLead(lead.id);
  if (known && (await isSuppressed(known.email_hash))) {
    await dropLead(lead.id, 'suppressed');
    ctx.summary.suppressed += 1;
    leadLog.info('suppressed before cascade');
    return;
  }

  // 4. The cascade, or the operator's own address when this is a smoke test.
  const hit = ctx.contactOverride
    ? {
        email: ctx.contactOverride.email,
        first_name: ctx.contactOverride.first_name,
        method: 'manual' as const,
        confidence: 100,
      }
    : await (async () => {
        const handle = await hnHandle();
        return resolveContact(lead, {
          submitterProfileUrl: handle ? profileUrl(handle) : null,
        });
      })();
  if (!hit) {
    await dropLead(lead.id, 'no_contact');
    ctx.summary.no_contact += 1;
    leadLog.info('no contact found');
    return;
  }

  const emailNorm = normalizeEmail(hit.email);
  if (!emailNorm) {
    await dropLead(lead.id, 'no_contact');
    ctx.summary.no_contact += 1;
    leadLog.warn('cascade returned an unusable address', { method: hit.method });
    return;
  }
  const emailHash = hashEmail(emailNorm, ctx.pepper);

  // 5. The contact row is written FIRST, then the two checks. §8.3 is
  //    explicit about this order: a drop that has no contact row behind it is
  //    not attributable, and attribution is what makes the §8.2 measurement
  //    of contacted_other_campaign possible. Do not reorder.
  await insertContact({
    lead_id: lead.id,
    email: hit.email,
    email_norm: emailNorm,
    email_hash: emailHash,
    first_name: hit.first_name,
    method: hit.method,
    confidence: hit.confidence,
  });

  if (await isSuppressed(emailHash)) {
    await dropLead(lead.id, 'suppressed');
    ctx.summary.suppressed += 1;
    leadLog.info('suppressed after cascade', { method: hit.method });
    return;
  }

  if (await hasLiveSend(emailHash)) {
    await dropLead(lead.id, 'contacted_other_campaign');
    ctx.summary.contacted_other_campaign += 1;
    leadLog.info('already contacted by another campaign', { method: hit.method });
    return;
  }

  await setLeadStatus(lead.id, 'contact_resolved');
  ctx.summary.resolved += 1;
  leadLog.info('contact resolved', { method: hit.method, confidence: hit.confidence });
}

async function pool<T>(items: T[], size: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(size, items.length)) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      await fn(items[index] as T);
    }
  });
  await Promise.all(workers);
}

export async function runResolve(): Promise<ResolveSummary> {
  const config = loadConfig();
  const env = loadEnv();

  clearPageCache();
  clearMxCache();

  const summary: ResolveSummary = {
    considered: 0,
    platform_domain: 0,
    jurisdiction_blocked: 0,
    no_match: 0,
    matched: 0,
    suppressed: 0,
    contacted_other_campaign: 0,
    no_contact: 0,
    resolved: 0,
  };

  // 'discovered' is the normal intake. 'matched' is a lead that got a campaign
  // and then threw somewhere in the contact cascade -- page fetches, DNS, RDAP,
  // a paid lookup -- which is the most failure-prone code in the repo. The catch
  // in the pool below leaves such a lead at 'matched' with drop_reason null, and
  // nothing else in the pipeline reads that status, so without picking it up
  // here the lead would sit there forever: never retried, never contacted, and
  // never counted in the §8.2 drop accounting, which would quietly understate
  // every share on /health.
  //
  // processLead is idempotent for a re-run: setLeadJurisdiction overwrites,
  // matchLead is pure, and insertContact is an upsert on (lead_id, email_hash).
  const leads = [
    ...(await listLeadsByStatus('discovered', BATCH_LIMIT)),
    ...(await listLeadsByStatus('matched', BATCH_LIMIT)),
  ];
  summary.considered = leads.length;
  if (leads.length === 0) {
    log.info('resolve complete', { ...summary });
    return summary;
  }

  const campaigns = await listCampaigns();
  const ctx: Context = {
    campaigns,
    candidates: routable(campaigns).map((c) => ({
      slug: c.slug,
      excludeTags: c.exclude_tags,
      excludeKeywords: c.exclude_keywords,
    })),
    blockedCountries: config.global.blocked_countries,
    pepper: env.PROBE_HASH_PEPPER,
    summary,
  };

  let failed = 0;
  await pool(leads, CONCURRENCY, async (lead) => {
    try {
      await processLead(lead, ctx);
    } catch (err) {
      // A lead that throws stays in `discovered` and is retried tomorrow. It
      // is deliberately not dropped: drop_reason is permanent and never
      // overwritten (§8.2), and "our fetch timed out" is not a verdict on the
      // lead. One lead failing must never abort the run.
      failed += 1;
      // Left in place rather than dropped: drop_reason is permanent and never
      // overwritten (§8.2), and "our fetch timed out" is not a verdict on the
      // lead. The next run picks it up again from either 'discovered' or
      // 'matched', whichever it reached.
      log.error('lead failed, left for the next run', {
        lead_id: lead.id,
        domain: lead.domain,
        status: lead.status,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  clearPageCache();
  clearMxCache();

  log.info('resolve complete', { ...summary, failed });
  return summary;
}

/**
 * One lead through the same processLead as the morning run, with the contact
 * cascade replaced by an address the operator typed. `cli smoke` uses this to
 * put a chosen product in front of the real pipeline.
 *
 * Deliberately not a shortcut: jurisdiction still gates, matching still routes,
 * suppression is still checked on both sides of the contact, and contact-once
 * still applies. The only thing that does not run is the address discovery the
 * operator has just done by hand.
 */
export async function resolveOneLead(
  leadId: string,
  contact: { email: string; first_name: string | null },
): Promise<{ lead: LeadRow; summary: ResolveSummary }> {
  const config = loadConfig();
  const env = loadEnv();

  const lead = await getLead(leadId);
  if (!lead) throw new Error(`no lead with id ${leadId}`);

  const summary: ResolveSummary = {
    considered: 1,
    platform_domain: 0,
    jurisdiction_blocked: 0,
    no_match: 0,
    matched: 0,
    suppressed: 0,
    contacted_other_campaign: 0,
    no_contact: 0,
    resolved: 0,
  };

  const campaigns = await listCampaigns();
  await processLead(lead, {
    campaigns,
    candidates: routable(campaigns).map((c) => ({
      slug: c.slug,
      excludeTags: c.exclude_tags,
      excludeKeywords: c.exclude_keywords,
    })),
    blockedCountries: config.global.blocked_countries,
    pepper: env.PROBE_HASH_PEPPER,
    summary,
    contactOverride: contact,
  });

  clearPageCache();
  clearMxCache();

  const after = await getLead(leadId);
  return { lead: after ?? lead, summary };
}

/**
 * The jurisdiction gate for a url, with no database and no side effects.
 *
 * `cli smoke --check` uses this to answer "would this target get through"
 * before a lead exists. Hunting for a rehearsal target by running the real
 * command is expensive in a way that is not obvious: a blocked lead is dropped,
 * drop_reason is permanent (§8.2), and a domain burned that way is unreachable
 * forever even if it later launches something worth writing about.
 *
 * Same guesses in the same order as step 1 of processLead, so an answer here is
 * the answer there.
 */
export async function checkJurisdiction(url: string): Promise<{
  domain: string;
  country: string | null;
  source: string;
  detail: string | null;
  allowed: boolean;
}> {
  const config = loadConfig();
  const domain = normalizeDomain(url);
  if (!domain) throw new Error(`${url} has no usable domain`);

  // guessJurisdiction reads five fields and never writes. A lead that does not
  // exist yet has no id and no HN submitter, which is what the nulls say.
  const lead = {
    id: '',
    source_id: 'manual',
    external_id: '',
    name: domain,
    url,
    domain,
  } as LeadRow;

  clearPageCache();
  const { guess, detail } = await guessJurisdiction(lead, async () => null);
  clearPageCache();

  return {
    domain,
    country: guess.country,
    source: guess.source,
    detail,
    allowed: !isBlockedJurisdiction(guess.country, config.global.blocked_countries),
  };
}
