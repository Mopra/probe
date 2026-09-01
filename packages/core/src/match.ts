import { isHttps } from './url';

// PLAN.md 8.2. Cheap and rule based, no LLM. This runs before a single contact
// lookup or generator call is spent, so it has to be fast and boring.

export interface MatchInput {
  name: string;
  url: string;
  description: string | null;
  tags: string[];
}

export interface MatchCandidate {
  slug: string;
  excludeTags: string[];
  excludeKeywords: string[];
}

export type MatchReason =
  | 'matched'
  | 'not_https'
  | 'excluded_tag'
  | 'excluded_keyword'
  | 'no_campaign';

export interface MatchResult {
  slug: string | null;
  reason: MatchReason;
  detail?: string;
}

/** 'Status Page', 'status_page' and 'status-page' are the same tag. */
function normalizeTag(tag: string): string {
  return String(tag)
    .toLowerCase()
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '');
}

function haystack(lead: MatchInput): string {
  return `${lead.name ?? ''} ${lead.description ?? ''}`.toLowerCase();
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Whole word or whole phrase, so 'apm' never fires inside 'apmex'. */
function containsPhrase(text: string, phrase: string): boolean {
  const p = phrase.toLowerCase().trim();
  if (p.length === 0) return false;
  return new RegExp(`(?:^|[^a-z0-9])${escapeRegExp(p)}(?:$|[^a-z0-9])`).test(text);
}

// Signals that a product has a surface worth probing: a public API, docs, a
// dashboard, anything a synthetic check can be pointed at (8.2 tiebreak 2).
const PROBEABLE_SIGNALS = [
  'api',
  'apis',
  'docs',
  'documentation',
  'endpoint',
  'endpoints',
  'sdk',
  'rest',
  'graphql',
  'webhook',
  'webhooks',
  'developer',
  'developers',
  'developer-tools',
  'dashboard',
  'saas',
  'platform',
  'self-hosted',
  'open-source',
];

/** True when the description or tags suggest an API or docs surface. */
export function looksProbeable(lead: MatchInput): boolean {
  const tags = new Set((lead.tags ?? []).map(normalizeTag));
  for (const signal of PROBEABLE_SIGNALS) {
    if (tags.has(signal)) return true;
  }
  const text = (lead.description ?? '').toLowerCase();
  if (text.length === 0) return false;
  for (const signal of PROBEABLE_SIGNALS) {
    if (containsPhrase(text, signal)) return true;
  }
  return false;
}

type Exclusion = { reason: 'excluded_tag' | 'excluded_keyword'; detail: string };

function excludedBy(lead: MatchInput, candidate: MatchCandidate): Exclusion | null {
  const tags = new Set((lead.tags ?? []).map(normalizeTag));
  for (const raw of candidate.excludeTags ?? []) {
    const tag = normalizeTag(raw);
    if (tag.length > 0 && tags.has(tag)) {
      return { reason: 'excluded_tag', detail: tag };
    }
  }
  const text = haystack(lead);
  for (const raw of candidate.excludeKeywords ?? []) {
    const keyword = String(raw).toLowerCase().trim();
    if (keyword.length > 0 && containsPhrase(text, keyword)) {
      return { reason: 'excluded_keyword', detail: keyword };
    }
  }
  return null;
}

/**
 * The exit1 generator points a synthetic probe suite at a public surface, so a
 * product that exposes one is likelier to yield a severity 1 finding. Other
 * campaigns have no such signal yet, so they never win this tiebreak.
 */
function generatorLikelyFinds(slug: string, lead: MatchInput): boolean {
  if (slug === 'exit1') return looksProbeable(lead);
  return false;
}

/**
 * Routes a lead to exactly one campaign (8.2). leads.campaign_id is singular:
 * a lead matching both campaigns produces one email, not two.
 *
 * Tiebreak in order:
 *   1. only campaigns whose exclusions the product does not trip survive
 *   2. prefer the campaign whose generator is likelier to find something
 *   3. round robin on rrCounter, so neither campaign starves
 */
export function matchLead(args: {
  lead: MatchInput;
  candidates: MatchCandidate[];
  rrCounter: number;
}): MatchResult {
  const { lead, candidates, rrCounter } = args;

  // A product we cannot reach over https cannot be probed, and an http-only
  // landing page is not a surface we want to write about anyway.
  if (!lead || typeof lead.url !== 'string' || !isHttps(lead.url)) {
    return { slug: null, reason: 'not_https', detail: lead?.url ?? '' };
  }

  const pool = Array.isArray(candidates) ? candidates.filter((c) => c && c.slug) : [];
  if (pool.length === 0) return { slug: null, reason: 'no_campaign' };

  const survivors: MatchCandidate[] = [];
  let firstExclusion: Exclusion | null = null;
  for (const candidate of pool) {
    const exclusion = excludedBy(lead, candidate);
    if (exclusion === null) {
      survivors.push(candidate);
    } else if (firstExclusion === null) {
      // Candidates arrive in file order, so this reports the exclusion of the
      // campaign we would most likely have picked. drop_reason is written once
      // and never overwritten, so it should be the most informative one.
      firstExclusion = exclusion;
    }
  }

  if (survivors.length === 0) {
    if (firstExclusion) {
      return { slug: null, reason: firstExclusion.reason, detail: firstExclusion.detail };
    }
    return { slug: null, reason: 'no_campaign' };
  }

  if (survivors.length === 1) {
    return { slug: (survivors[0] as MatchCandidate).slug, reason: 'matched' };
  }

  const preferred = survivors.filter((c) => generatorLikelyFinds(c.slug, lead));
  if (preferred.length === 1) {
    return { slug: (preferred[0] as MatchCandidate).slug, reason: 'matched', detail: 'probeable' };
  }

  const rrPool = preferred.length > 1 ? preferred : survivors;
  const n = rrPool.length;
  const counter = Number.isFinite(rrCounter) ? Math.trunc(rrCounter) : 0;
  const index = ((counter % n) + n) % n;
  return { slug: (rrPool[index] as MatchCandidate).slug, reason: 'matched', detail: 'round_robin' };
}
