import { logger } from '@probe/config';

export const dynamic = 'force-dynamic';

const log = logger('web:evidence');

/**
 * §9.2.3. The public report every email links to.
 *
 * WHY THIS IS A PROXY. The report is exit1's artifact: exit1 ran the check and
 * exit1 stores it, so probe has no copy to serve. The generator originally
 * emitted `https://exit1.dev/probe/<id>`, but exit1.dev is served by Vercel with
 * no vercel.json, so the Firebase Hosting rewrite that would have routed it is
 * inert and the URL 404s. Rather than change the routing of a live marketing
 * site, probe serves the report from its own domain and fetches it from the
 * function behind the scenes.
 *
 * The recipient sees `probe.exit1.dev/e/<id>`: a subdomain of exit1.dev, so the
 * link still reads as ours, and honest about what produced it.
 *
 * §9.2.3 is the specification for this page and it is unusually strict: public,
 * no signup wall, no email capture, no "claim this report" gate, no retargeting
 * pixel. The conversion mechanism is the quality of the artifact. So this route
 * requires no auth (it is on the Cloudflare Access bypass list with /u, /c and
 * /data), sets no cookies, and adds no tracking of its own. The only signal
 * probe records is the /c/:token click that brought the reader here.
 */

const DEFAULT_ORIGIN = 'https://europe-west1-exit1-dev.cloudfunctions.net/probeEvidence';

/** The id shape probeEvidence mints: randomUUID(). Validated before any fetch,
 *  so this route cannot be turned into an open proxy by a crafted path. */
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\.json)?$/i;

const FETCH_TIMEOUT_MS = 15_000;

function evidenceOrigin(): string {
  const raw = process.env.PROBE_EVIDENCE_ORIGIN?.trim();
  return (raw && raw.length > 0 ? raw : DEFAULT_ORIGIN).replace(/\/+$/, '');
}

function notFound(): Response {
  return new Response('No such report.\n', {
    status: 404,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  });
}

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await ctx.params;

  if (!ID.test(id)) {
    // Not a report id, so there is nothing to look up and nothing to fetch.
    // Answered here rather than forwarded: the allowlist is what keeps this
    // route from being a general-purpose fetcher for whoever finds it.
    return notFound();
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${evidenceOrigin()}/${id}`, {
      headers: { accept: 'text/html,application/json;q=0.9' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    // A recipient clicked a link in an email. Telling them the report is
    // temporarily unavailable is the truth; a 500 stack is not their problem.
    log.error('evidence upstream unreachable', { id, error: String(err) });
    return new Response(
      'That report could not be loaded just now. Reply to the email you received and I will send it to you.\n',
      { status: 502, headers: { 'content-type': 'text/plain; charset=utf-8' } },
    );
  }

  if (upstream.status === 404) return notFound();
  if (!upstream.ok) {
    log.error('evidence upstream error', { id, status: upstream.status });
    return new Response('That report could not be loaded just now.\n', {
      status: 502,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }

  const body = await upstream.text();
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': upstream.headers.get('content-type') ?? 'text/html; charset=utf-8',
      // The report is immutable once written, so it caches well. Five minutes
      // matches what probeEvidence itself sends.
      'cache-control': 'public, max-age=300',
      // The page holds a stranger's launch-day problem. It should not be indexed.
      'x-robots-tag': 'noindex, nofollow',
      'referrer-policy': 'no-referrer',
    },
  });
}
