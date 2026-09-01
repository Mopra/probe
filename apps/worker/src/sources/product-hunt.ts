// Product Hunt, via the v2 GraphQL API (§8.1).
//
// Needs PRODUCT_HUNT_TOKEN. Without one the source ships disabled rather than
// broken: an optional token that is not set is a configuration state, not a
// sweep failure, and runSweep must not record an error for it.

import { logger, loadEnv } from '@probe/config';
import { fetchText, postJson, withRetry } from '../lib/http';
import type { RawLead, Source } from '../types';

const log = logger('source.product_hunt');

const ENDPOINT = 'https://api.producthunt.com/v2/api/graphql';

/** One day of posts. Same self-healing reason as Show HN: the window is wider
 *  than the sweep interval so a missed morning is picked up the next day. */
const WINDOW_HOURS = 36;
const PAGE_SIZE = 50;

const QUERY = `
query ProbePosts($postedAfter: DateTime!, $first: Int!) {
  posts(order: NEWEST, postedAfter: $postedAfter, first: $first) {
    edges {
      node {
        id
        name
        tagline
        description
        website
        url
        createdAt
        topics { edges { node { name } } }
        makers { name twitterUsername websiteUrl }
      }
    }
  }
}`.trim();

interface PhMaker {
  name?: string | null;
  twitterUsername?: string | null;
  websiteUrl?: string | null;
}

interface PhNode {
  id?: string;
  name?: string | null;
  tagline?: string | null;
  description?: string | null;
  website?: string | null;
  url?: string | null;
  createdAt?: string | null;
  topics?: { edges?: Array<{ node?: { name?: string | null } }> };
  makers?: PhMaker[];
}

interface PhResponse {
  data?: { posts?: { edges?: Array<{ node?: PhNode }> } };
  errors?: Array<{ message?: string }>;
}

/** The env loader throws when an unrelated required variable is missing, and
 *  the enabled flag still has to be answerable: /health lists every source on
 *  boot, including the ones that are off. Falls back to the raw variable. */
function productHuntToken(): string | undefined {
  try {
    return loadEnv().PRODUCT_HUNT_TOKEN;
  } catch {
    return process.env.PRODUCT_HUNT_TOKEN || undefined;
  }
}

export function phTags(node: PhNode): string[] {
  const topics = node.topics?.edges ?? [];
  const tags: string[] = [];
  for (const edge of topics) {
    const name = (edge?.node?.name ?? '').trim();
    if (!name) continue;
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    if (slug && !tags.includes(slug)) tags.push(slug);
  }
  return tags.slice(0, 8);
}

/** `website` on a Product Hunt post is a redirect through producthunt.com.
 *  Storing that URL would put producthunt.com in leads.domain for every post,
 *  which makes leads_domain_uniq (§7) collapse the whole day into one lead.
 *  fetchText follows redirects, so the landed URL is the real one. */
export async function resolveWebsite(website: string): Promise<string> {
  const res = await fetchText(website, { timeoutMs: 10_000 });
  const landed = (res.url || '').trim();
  if (!landed) return website;
  try {
    const host = new URL(landed).hostname.toLowerCase();
    if (host.endsWith('producthunt.com')) return website;
  } catch {
    return website;
  }
  return landed;
}

export async function nodeToRawLead(node: PhNode): Promise<RawLead | null> {
  const externalId = (node.id ?? '').trim();
  const name = (node.name ?? '').trim();
  if (!externalId || !name) return null;

  const website = (node.website ?? '').trim();
  if (!website) return null;

  const url = await resolveWebsite(website);

  const tagline = (node.tagline ?? '').trim();
  const description = (node.description ?? '').trim();
  const maker = (node.makers ?? []).find((m) => (m?.websiteUrl ?? '').trim());

  return {
    external_id: externalId,
    name,
    url,
    description: tagline || description || null,
    tags: phTags(node),
    launched_at: node.createdAt ? new Date(node.createdAt) : null,
    submitter: maker
      ? {
          handle: (maker.name ?? maker.twitterUsername ?? '').trim() || undefined,
          profile_url: (maker.websiteUrl ?? '').trim() || undefined,
        }
      : undefined,
  };
}

export async function sweepProductHunt(now: Date = new Date()): Promise<RawLead[]> {
  const token = productHuntToken();
  if (!token) {
    throw new Error('PRODUCT_HUNT_TOKEN is not set');
  }

  const postedAfter = new Date(now.getTime() - WINDOW_HOURS * 3600 * 1000).toISOString();
  const body = JSON.stringify({ query: QUERY, variables: { postedAfter, first: PAGE_SIZE } });

  const res = await withRetry(
    () =>
      postJson(ENDPOINT, body, {
        timeoutMs: 20_000,
        headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      }),
    { attempts: 3, shouldRetry: (r) => !r.ok },
  );
  if (!res.ok) {
    throw new Error(`product hunt graphql failed: status ${res.status}${res.error ? `: ${res.error}` : ''}`);
  }

  let parsed: PhResponse;
  try {
    parsed = JSON.parse(res.text) as PhResponse;
  } catch (err) {
    throw new Error(`product hunt returned invalid json: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (parsed.errors?.length) {
    throw new Error(`product hunt graphql errors: ${parsed.errors.map((e) => e?.message ?? '?').join('; ')}`);
  }

  const edges = parsed.data?.posts?.edges ?? [];
  const leads: RawLead[] = [];
  for (const edge of edges) {
    if (!edge?.node) continue;
    const lead = await nodeToRawLead(edge.node);
    if (lead) leads.push(lead);
  }
  log.debug('product hunt sweep', { posts: edges.length, usable: leads.length, postedAfter });
  return leads;
}

export const productHunt: Source = {
  id: 'product_hunt',
  name: 'Product Hunt',
  kind: 'api',
  // A getter, not a constant: the token is read when the flag is read, so
  // importing this module never depends on the environment being complete.
  get enabled(): boolean {
    return Boolean(productHuntToken());
  },
  sweep: () => sweepProductHunt(),
};
