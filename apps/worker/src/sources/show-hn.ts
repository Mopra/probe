// Show HN, via the Algolia Hacker News API (§8.1).
//
// Show HN is the anchor source: it is a stable public API, it needs no token,
// and every post carries a submitter handle, which is step 2 of the contact
// cascade (§8.3) and the fourth jurisdiction guess (§8.2).

import { load } from 'cheerio';
import { logger } from '@probe/config';
import { fetchJson, withRetry } from '../lib/http';
import type { RawLead, Source } from '../types';

const log = logger('source.show_hn');

const ALGOLIA_SEARCH = 'https://hn.algolia.com/api/v1/search_by_date';
const ALGOLIA_ITEM = 'https://hn.algolia.com/api/v1/items';

/** Roughly a day and a half. The sweep runs at 06:30; a window wider than the
 *  interval means a missed morning heals itself on the next run instead of
 *  leaving a hole nobody notices. Duplicates are free: insertLead returns null
 *  on conflict (§8.1). */
const WINDOW_HOURS = 36;

const HITS_PER_PAGE = 100;

interface AlgoliaHit {
  objectID?: string;
  title?: string | null;
  url?: string | null;
  author?: string | null;
  created_at?: string | null;
  created_at_i?: number | null;
  story_text?: string | null;
}

interface AlgoliaSearchResponse {
  hits?: AlgoliaHit[];
}

interface AlgoliaItem {
  id?: number;
  author?: string | null;
}

/** Separators HN titles use between a product name and its tagline. The long
 *  dashes are written as escapes on purpose: this repo never types one as
 *  punctuation, but it still has to read the ones other people type.
 *  \u2013 en dash, \u2014 em dash, \u2015 horizontal bar. */
const TITLE_SEPARATOR = /\s+[\u2013\u2014\u2015-]\s+|\s*[:|]\s+/;

const SHOW_HN_PREFIX = /^\s*show\s*hn\s*[:\u2013\u2014\u2015-]\s*/i;

/** Small, honest and deliberately incomplete. Every tag here can exclude a
 *  lead from a campaign (§8.2, `exclude_tags`), so a wrong tag costs a real
 *  lead and a missing one costs a wrong email. Patterns that are merely
 *  plausible are left out. */
const TAG_RULES: Array<{ tag: string; pattern: RegExp }> = [
  { tag: 'api', pattern: /\bapis?\b|\bgraphql\b|\bwebhooks?\b/i },
  {
    tag: 'developer-tools',
    pattern:
      /\bdev(eloper)?[- ]?tools?\b|\bfor developers\b|\bsdk\b|\blibrar(y|ies)\b|\bframework\b|\bdebugger\b|\blinter\b|\bcompiler\b/i,
  },
  { tag: 'cli', pattern: /\bcli\b|\bcommand[- ]line\b|\bterminal\b|\btui\b/i },
  { tag: 'saas', pattern: /\bsaas\b|\bb2b\b|\bsubscriptions?\b/i },
  { tag: 'billing', pattern: /\bbilling\b|\binvoic(e|es|ing)\b|\bpayments?\b|\bmetering\b/i },
  {
    tag: 'ai',
    pattern:
      /\bai\b|\ba\.i\.|\bllms?\b|\bgpt\b|\bchatgpt\b|\bclaude\b|\bmachine[- ]learning\b|\bneural\b|\brag\b|\bembeddings?\b|\bprompts?\b/i,
  },
  {
    tag: 'open-source',
    pattern: /\bopen[- ]sourc(e|ed)\b|\boss\b|\bself[- ]host(ed|ing)?\b|\bmit licen[cs]e\b|\bapache 2\b/i,
  },
  { tag: 'monitoring', pattern: /\bmonitor(s|ing)?\b|\balert(s|ing)\b|\bincidents?\b|\bon[- ]call\b/i },
  { tag: 'observability', pattern: /\bobservability\b|\btracing\b|\bopentelemetry\b|\botel\b|\blog aggregat/i },
  { tag: 'uptime', pattern: /\buptime\b|\bdowntime\b|\bhealth ?checks?\b|\bheartbeats?\b/i },
  { tag: 'status-page', pattern: /\bstatus[- ]pages?\b/i },
  { tag: 'apm', pattern: /\bapm\b|\bapplication performance monitoring\b/i },
  { tag: 'analytics', pattern: /\banalytics\b|\bdashboards?\b/i },
  { tag: 'security', pattern: /\bsecurity\b|\bauthentication\b|\boauth\b|\bencrypt(ion|ed)\b|\bvulnerabilit/i },
  { tag: 'database', pattern: /\bdatabases?\b|\bpostgres(ql)?\b|\bsqlite\b|\bmysql\b|\bredis\b/i },
  { tag: 'docs', pattern: /\bdocumentation\b|\bdocs\b|\bopenapi\b|\bswagger\b/i },
];

const MAX_TAGS = 6;
const MAX_DESCRIPTION = 500;

/** Strips the 'Show HN:' prefix and any trailing tagline, so the name is the
 *  product name and nothing else. */
export function parseShowHnTitle(rawTitle: string): { name: string; tagline: string | null } {
  const stripped = rawTitle.replace(SHOW_HN_PREFIX, '').trim();
  if (!stripped) return { name: rawTitle.trim(), tagline: null };

  const match = TITLE_SEPARATOR.exec(stripped);
  if (!match || match.index === 0) return { name: stripped, tagline: null };

  const name = stripped.slice(0, match.index).trim();
  const tagline = stripped.slice(match.index + match[0].length).trim();
  if (!name) return { name: stripped, tagline: null };
  return { name, tagline: tagline || null };
}

/** Cheap keyword tagging over the title plus whatever body text there is. */
export function deriveTags(...parts: Array<string | null | undefined>): string[] {
  const haystack = parts.filter(Boolean).join(' ');
  if (!haystack.trim()) return [];
  const tags: string[] = [];
  for (const rule of TAG_RULES) {
    if (rule.pattern.test(haystack)) tags.push(rule.tag);
    if (tags.length >= MAX_TAGS) break;
  }
  return tags;
}

/** HN story_text is HTML: entity encoded, with <p> and <a>. Block elements
 *  get a separator first, so two paragraphs do not become one run-on word. */
export function plainText(html: string): string {
  const $ = load(`<div>${html}</div>`);
  $('p, br, div, li, tr, blockquote, pre').after(' ');
  return $.text().replace(/\s+/g, ' ').trim();
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 3).trimEnd()}...`;
}

export function hitToRawLead(hit: AlgoliaHit): RawLead | null {
  const externalId = hit.objectID;
  const title = (hit.title ?? '').trim();
  if (!externalId || !title) return null;

  // A text-only Show HN has no public surface to probe, so there is nothing a
  // generator could ever find. Skipped rather than stored broken.
  const url = (hit.url ?? '').trim();
  if (!url) return null;

  const { name, tagline } = parseShowHnTitle(title);
  const body = hit.story_text ? plainText(hit.story_text) : '';
  const description = tagline ?? (body ? truncate(body, MAX_DESCRIPTION) : null);

  const author = (hit.author ?? '').trim();

  return {
    external_id: externalId,
    name,
    url,
    description,
    tags: deriveTags(title, description, body),
    launched_at: hit.created_at ? new Date(hit.created_at) : null,
    submitter: author
      ? {
          handle: author,
          profile_url: `https://news.ycombinator.com/user?id=${encodeURIComponent(author)}`,
        }
      : undefined,
  };
}

/** The submitter handle for a story, by Algolia objectID. jobs/resolve.ts
 *  needs it: leads store the objectID but not the author, and the HN profile
 *  is both a contact step and a jurisdiction signal. */
export async function hnAuthorForItem(objectId: string): Promise<string | null> {
  const res = await fetchJson<AlgoliaItem>(`${ALGOLIA_ITEM}/${encodeURIComponent(objectId)}`);
  if (!res.ok || !res.data) return null;
  const author = (res.data.author ?? '').trim();
  return author || null;
}

export async function sweepShowHn(now: Date = new Date()): Promise<RawLead[]> {
  const since = Math.floor(now.getTime() / 1000) - WINDOW_HOURS * 3600;
  const url =
    `${ALGOLIA_SEARCH}?tags=show_hn&hitsPerPage=${HITS_PER_PAGE}` +
    `&numericFilters=${encodeURIComponent(`created_at_i>${since}`)}`;

  const res = await withRetry(() => fetchJson<AlgoliaSearchResponse>(url), {
    attempts: 3,
    shouldRetry: (r) => !r.ok,
  });
  if (!res.ok || !res.data) {
    throw new Error(`algolia search failed: status ${res.status}${res.error ? `: ${res.error}` : ''}`);
  }

  const hits = res.data.hits ?? [];
  const leads: RawLead[] = [];
  for (const hit of hits) {
    const lead = hitToRawLead(hit);
    if (lead) leads.push(lead);
  }
  log.debug('show hn sweep', { hits: hits.length, usable: leads.length, since });
  return leads;
}

export const showHn: Source = {
  id: 'show_hn',
  name: 'Show HN',
  kind: 'api',
  enabled: true,
  sweep: () => sweepShowHn(),
};
