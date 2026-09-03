import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { verifyAccessJwt } from './app/lib/cf-access';

/**
 * Cloudflare Access sits in front of this app (§9.3), and this middleware
 * verifies its signed assertion rather than trusting a header.
 *
 * The dashboard holds every founder's plaintext address probe has resolved.
 * `Cf-Access-Authenticated-User-Email` is set by Cloudflare, but a request that
 * reaches the Vercel origin directly (the `*.vercel.app` hostname, or a preview
 * deployment's own hostname) never passed through Cloudflare and can set that
 * header to anything. So the header is not the gate: `Cf-Access-Jwt-Assertion`
 * is, and app/lib/cf-access.ts verifies its RS256 signature against the team's
 * published keys and checks the audience tag.
 *
 * Five paths are never gated, and that is deliberate: §4 says an unsubscribe
 * that 404s while a batch is in flight is a compliance incident, not a bug.
 *   /u/:token    one click unsubscribe, no login, no JavaScript (§9.3)
 *   /c/:token    click redirect, hit by recipients' mail clients (§8.7)
 *   /data        the GDPR Article 14 notice linked from every email (§9.2.4)
 *   /e/:id       the public evidence report, which is THE link in every email.
 *                §9.2.3: no signup wall, no email capture, no gate of any kind.
 *   /hooks/*     Day3 and SNS post here; neither carries an Access identity.
 *                Both verify their own signatures instead (§8.7).
 */
const NEVER_GATED = [/^\/u\//, /^\/c\//, /^\/data(\/|$)/, /^\/e\//, /^\/hooks\//];

const JWT_HEADER = 'cf-access-jwt-assertion';
const EMAIL_HEADER = 'cf-access-authenticated-user-email';

function isPublic(pathname: string): boolean {
  return NEVER_GATED.some((re) => re.test(pathname));
}

function allowedEmails(): string[] {
  return (process.env.CF_ACCESS_ALLOWED_EMAILS ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

function forbidden(message: string): NextResponse {
  return new NextResponse(`Forbidden: ${message}\n`, {
    status: 403,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  });
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // The nav needs to know which screen is current, and reading it here keeps
  // the layout a server component with no client router hook.
  const headers = new Headers(req.headers);
  headers.set('x-probe-path', pathname);
  // Whatever the client sent under the identity header is stripped before the
  // app sees it, so no server component can accidentally trust it. Only the
  // value derived from a verified assertion below is put back.
  headers.delete(EMAIL_HEADER);
  const pass = () => NextResponse.next({ request: { headers } });

  if (isPublic(pathname)) return pass();

  const required = process.env.CF_ACCESS_REQUIRED !== 'false';
  const teamDomain = (process.env.CF_ACCESS_TEAM_DOMAIN ?? '').trim();
  const audience = (process.env.CF_ACCESS_AUD ?? '').trim();
  const allowed = allowedEmails();

  if (!required) {
    // The escape hatch for `pnpm web:dev`, and it has to be explicit. The old
    // default was the other way round -- unset meant ungated -- so one missing
    // Vercel environment variable removed the gate entirely and nothing said
    // so. Now the deployment has to ask for that.
    if (process.env.NODE_ENV === 'production') {
      console.warn(
        '[probe] CF_ACCESS_REQUIRED=false in production: the operator screens are UNAUTHENTICATED.',
      );
    }
    return pass();
  }

  if (!teamDomain || !audience) {
    return forbidden(
      'Cloudflare Access is not configured on this deployment. Set CF_ACCESS_TEAM_DOMAIN and ' +
        'CF_ACCESS_AUD, or set CF_ACCESS_REQUIRED=false for local development.',
    );
  }
  if (allowed.length === 0) {
    // An empty allowlist used to mean "nobody", which is correct, but it read
    // as a configuration mistake rather than a decision. Saying so is kinder.
    return forbidden('CF_ACCESS_ALLOWED_EMAILS is empty, so no identity can be admitted.');
  }

  const result = await verifyAccessJwt({
    token: req.headers.get(JWT_HEADER),
    teamDomain,
    audience,
  });
  if (!result.ok) {
    return forbidden(`Cloudflare Access assertion rejected (${result.reason}).`);
  }
  if (!allowed.includes(result.identity.email)) {
    return forbidden('this identity is not on the probe allowlist.');
  }

  // Put the verified identity back for the app to read. This is now the only
  // source of that header inside the app.
  headers.set(EMAIL_HEADER, result.identity.email);
  return NextResponse.next({ request: { headers } });
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|robots.txt).*)'],
};
