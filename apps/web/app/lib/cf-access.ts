/**
 * Cloudflare Access JWT verification (§9.3).
 *
 * This runs in Next.js middleware, on the edge runtime, so it uses Web Crypto
 * and fetch and imports nothing from @probe/* (which pulls in node builtins).
 *
 * WHY THIS EXISTS AT ALL. The previous gate read
 * `Cf-Access-Authenticated-User-Email` and trusted it. That header is set by
 * Cloudflare, but nothing stopped a request from reaching the Vercel origin
 * without passing through Cloudflare: a deployment is reachable at its
 * `*.vercel.app` hostname, and preview deployments get their own hostnames too.
 * So `curl -H 'cf-access-authenticated-user-email: <allowlisted address>'`
 * against the origin returned /queue, /leads and the raw `.eml` preview, which
 * between them hold every founder's plaintext address probe has ever resolved.
 * A header a client can set is not authentication.
 *
 * What Cloudflare actually signs is `Cf-Access-Jwt-Assertion`: a JWT, RS256,
 * with the Access application's AUD tag in `aud` and the identity in `email`.
 * Verifying that signature against the team's published keys is the whole point,
 * because a signature cannot be forged by whoever happens to reach the origin.
 *
 * Belt and braces, not either/or: Vercel Deployment Protection should ALSO be
 * on, so the origin is not reachable without Cloudflare in front. This code is
 * what makes the app safe if it ever is.
 */

export interface AccessIdentity {
  email: string;
  /** Cloudflare's user id for the identity, when present. */
  sub: string | null;
}

export type AccessResult =
  | { ok: true; identity: AccessIdentity }
  | { ok: false; reason: string };

interface Jwk {
  kid?: string;
  kty?: string;
  alg?: string;
  use?: string;
  n?: string;
  e?: string;
}

/** Cloudflare rotates signing keys roughly weekly and publishes the next one
 *  ahead of time, so a short cache is safe and a long one is not. */
const JWKS_TTL_MS = 10 * 60 * 1000;

const jwksCache = new Map<string, { keys: Jwk[]; expiresAt: number }>();

/** Test seam. The cache is module level and would leak between tests. */
export function clearAccessKeyCache(): void {
  jwksCache.clear();
}

function base64UrlToBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

function decodeJson(segment: string): Record<string, unknown> | null {
  try {
    const bytes = base64UrlToBytes(segment);
    return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Normalizes 'team' / 'team.cloudflareaccess.com' / a full URL to an origin. */
export function teamCertsUrl(teamDomain: string): string | null {
  const raw = teamDomain.trim().replace(/\/+$/, '');
  if (raw.length === 0) return null;
  let host = raw.replace(/^https?:\/\//i, '').split('/')[0] ?? '';
  if (host.length === 0) return null;
  if (!host.includes('.')) host = `${host}.cloudflareaccess.com`;
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(host)) return null;
  // Only Cloudflare's own host may serve the keys. Without this check the team
  // domain becomes an injection point: point it anywhere and every token
  // verifies.
  if (!/\.cloudflareaccess\.com$/i.test(host)) return null;
  return `https://${host}/cdn-cgi/access/certs`;
}

async function fetchKeys(certsUrl: string, doFetch: typeof fetch): Promise<Jwk[] | null> {
  const cached = jwksCache.get(certsUrl);
  if (cached && cached.expiresAt > Date.now()) return cached.keys;

  try {
    const res = await doFetch(certsUrl, { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) return null;
    const body = (await res.json()) as { keys?: Jwk[] };
    const keys = Array.isArray(body?.keys) ? body.keys : null;
    if (!keys || keys.length === 0) return null;
    jwksCache.set(certsUrl, { keys, expiresAt: Date.now() + JWKS_TTL_MS });
    return keys;
  } catch {
    return null;
  }
}

async function verifySignature(
  jwk: Jwk,
  signingInput: string,
  signature: Uint8Array,
): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey(
      'jwk',
      { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify'],
    );
    return await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      key,
      signature as unknown as ArrayBuffer,
      new TextEncoder().encode(signingInput) as unknown as ArrayBuffer,
    );
  } catch {
    return false;
  }
}

/**
 * Verifies a Cloudflare Access assertion. Fails closed on everything: a missing
 * token, an unreachable key endpoint, an unexpected algorithm, a wrong
 * audience, an expired token.
 *
 * `aud` is checked because the signature alone is not enough. Every Access
 * application in a team is signed by the same keys, so a token minted for some
 * other application in the same account would verify perfectly. The AUD tag is
 * what ties the token to THIS application.
 */
export async function verifyAccessJwt(args: {
  token: string | null | undefined;
  teamDomain: string;
  audience: string;
  nowMs?: number;
  fetchImpl?: typeof fetch;
}): Promise<AccessResult> {
  const { token, teamDomain, audience } = args;
  if (!token || token.trim().length === 0) {
    return { ok: false, reason: 'no Cf-Access-Jwt-Assertion on the request' };
  }
  if (!audience.trim()) {
    return { ok: false, reason: 'CF_ACCESS_AUD is not configured' };
  }
  const certsUrl = teamCertsUrl(teamDomain);
  if (!certsUrl) {
    return { ok: false, reason: 'CF_ACCESS_TEAM_DOMAIN is not a cloudflareaccess.com host' };
  }

  const parts = token.trim().split('.');
  if (parts.length !== 3) return { ok: false, reason: 'assertion is not a three part JWT' };
  const [headerB64, payloadB64, signatureB64] = parts as [string, string, string];

  const header = decodeJson(headerB64);
  if (!header) return { ok: false, reason: 'assertion header is not JSON' };
  // Only RS256. Accepting 'none', or an HMAC algorithm keyed on public material,
  // is the classic JWT forgery and there is no reason to allow either.
  if (header.alg !== 'RS256') {
    return { ok: false, reason: `unexpected JWT algorithm ${String(header.alg)}` };
  }

  const payload = decodeJson(payloadB64);
  if (!payload) return { ok: false, reason: 'assertion payload is not JSON' };

  const keys = await fetchKeys(certsUrl, args.fetchImpl ?? fetch);
  if (!keys) return { ok: false, reason: `could not read signing keys from ${certsUrl}` };

  const kid = typeof header.kid === 'string' ? header.kid : null;
  // Prefer the key the token names, but try the rest too: mid-rotation, a token
  // may be signed by a key whose kid we have not refreshed yet.
  const ordered = kid ? [...keys.filter((k) => k.kid === kid), ...keys.filter((k) => k.kid !== kid)] : keys;

  const signingInput = `${headerB64}.${payloadB64}`;
  let signature: Uint8Array;
  try {
    signature = base64UrlToBytes(signatureB64);
  } catch {
    return { ok: false, reason: 'assertion signature is not base64url' };
  }

  let verified = false;
  for (const jwk of ordered) {
    if (jwk.kty !== 'RSA' || !jwk.n || !jwk.e) continue;
    if (await verifySignature(jwk, signingInput, signature)) {
      verified = true;
      break;
    }
  }
  if (!verified) return { ok: false, reason: 'assertion signature did not verify' };

  const nowSeconds = Math.floor((args.nowMs ?? Date.now()) / 1000);
  const exp = typeof payload.exp === 'number' ? payload.exp : null;
  const nbf = typeof payload.nbf === 'number' ? payload.nbf : null;
  // 60s of skew, in both directions. Enough for a clock that drifts, far too
  // little to be useful to anyone replaying an old token.
  if (exp === null || nowSeconds > exp + 60) return { ok: false, reason: 'assertion has expired' };
  if (nbf !== null && nowSeconds < nbf - 60) {
    return { ok: false, reason: 'assertion is not valid yet' };
  }

  const aud = payload.aud;
  const audiences = Array.isArray(aud) ? aud.map(String) : typeof aud === 'string' ? [aud] : [];
  if (!audiences.includes(audience.trim())) {
    return {
      ok: false,
      reason: 'assertion was issued for a different Access application (aud mismatch)',
    };
  }

  const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : '';
  if (email.length === 0) return { ok: false, reason: 'assertion carries no email claim' };

  return {
    ok: true,
    identity: { email, sub: typeof payload.sub === 'string' ? payload.sub : null },
  };
}
