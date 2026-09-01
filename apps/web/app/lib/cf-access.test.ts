import { createSign, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';

import { clearAccessKeyCache, teamCertsUrl, verifyAccessJwt } from './cf-access';

/**
 * The gate on every screen holding a founder's plaintext address.
 *
 * What this replaced: a read of `Cf-Access-Authenticated-User-Email`, trusted.
 * That header is set by Cloudflare, but a request that reaches the Vercel origin
 * directly never passed through Cloudflare and can set it to anything. The
 * "forges an identity by setting a header" test below is the one that matters:
 * it is the attack that worked.
 */

const TEAM = 'pradsgaard.cloudflareaccess.com';
const CERTS_URL = `https://${TEAM}/cdn-cgi/access/certs`;
const AUD = 'a'.repeat(64);
const NOW_MS = 1_788_000_000_000;
const NOW_S = Math.floor(NOW_MS / 1000);

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const other = generateKeyPairSync('rsa', { modulusLength: 2048 });

function b64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function jwkOf(key: KeyObject, kid: string): Record<string, unknown> {
  const jwk = key.export({ format: 'jwk' }) as Record<string, unknown>;
  return { ...jwk, kid, alg: 'RS256', use: 'sig' };
}

function sign(
  payload: Record<string, unknown>,
  opts: { key?: KeyObject; kid?: string; alg?: string } = {},
): string {
  const header = b64url(JSON.stringify({ alg: opts.alg ?? 'RS256', kid: opts.kid ?? 'kid-1', typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${body}`);
  signer.end();
  return `${header}.${body}.${b64url(signer.sign(opts.key ?? privateKey))}`;
}

function claims(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    aud: [AUD],
    email: 'mpg@optipeople.dk',
    sub: 'user-1',
    iat: NOW_S - 10,
    exp: NOW_S + 3600,
    ...over,
  };
}

function keyServer(keys: Array<Record<string, unknown>> = [jwkOf(publicKey, 'kid-1')]) {
  let calls = 0;
  const fetchImpl = (async (url: string) => {
    calls += 1;
    if (url !== CERTS_URL) return new Response('not found', { status: 404 });
    return new Response(JSON.stringify({ keys }), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls: () => calls };
}

async function verify(
  token: string | null | undefined,
  over: { teamDomain?: string; audience?: string; nowMs?: number; fetchImpl?: typeof fetch } = {},
) {
  return verifyAccessJwt({
    token,
    teamDomain: over.teamDomain ?? TEAM,
    audience: over.audience ?? AUD,
    nowMs: over.nowMs ?? NOW_MS,
    fetchImpl: over.fetchImpl ?? keyServer().fetchImpl,
  });
}

beforeEach(() => {
  clearAccessKeyCache();
});

describe('teamCertsUrl', () => {
  it('accepts a bare team name, a host, and a url', () => {
    expect(teamCertsUrl('pradsgaard')).toBe(CERTS_URL);
    expect(teamCertsUrl(TEAM)).toBe(CERTS_URL);
    expect(teamCertsUrl(`https://${TEAM}/`)).toBe(CERTS_URL);
  });

  it('refuses any host that is not cloudflareaccess.com', () => {
    // Without this the team domain is an injection point: point it at a host you
    // control and every token you mint verifies.
    for (const bad of ['evil.example.com', 'https://evil.example.com', 'cloudflareaccess.com.evil.example', '', '   ']) {
      expect(teamCertsUrl(bad), bad).toBeNull();
    }
  });
});

describe('verifyAccessJwt', () => {
  it('accepts a properly signed assertion and returns the identity', async () => {
    const result = await verify(sign(claims()));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.identity.email).toBe('mpg@optipeople.dk');
      expect(result.identity.sub).toBe('user-1');
    }
  });

  it('lowercases the email, so the allowlist comparison cannot miss', async () => {
    const result = await verify(sign(claims({ email: 'MPG@Optipeople.DK' })));
    expect(result.ok && result.identity.email).toBe('mpg@optipeople.dk');
  });

  it('rejects a missing assertion', async () => {
    for (const token of [undefined, null, '', '   ']) {
      const result = await verify(token);
      expect(result.ok, String(token)).toBe(false);
    }
  });

  it('rejects an assertion signed by a key Cloudflare does not publish', async () => {
    // This is the forged-identity case. Anyone can mint a JWT; only Cloudflare
    // can sign one with a key on the team's certs endpoint.
    const result = await verify(sign(claims(), { key: other.privateKey }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('signature');
  });

  it('rejects alg none and alg HS256', async () => {
    // The classic JWT forgeries: drop the signature, or key an HMAC on material
    // the attacker also has.
    for (const alg of ['none', 'HS256', 'RS512']) {
      const result = await verify(sign(claims(), { alg }));
      expect(result.ok, alg).toBe(false);
      if (!result.ok) expect(result.reason, alg).toContain('algorithm');
    }
  });

  it('rejects a token minted for a different Access application', async () => {
    // Every application in a Cloudflare team is signed by the SAME keys, so a
    // valid signature is not enough: the aud tag is what ties the token to this
    // application. Without this check, any app in the account is a way in.
    const result = await verify(sign(claims({ aud: ['b'.repeat(64)] })));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('aud');
  });

  it('accepts a token whose aud array contains our tag among others', async () => {
    const result = await verify(sign(claims({ aud: ['b'.repeat(64), AUD] })));
    expect(result.ok).toBe(true);
  });

  it('rejects an expired token, with a little skew', async () => {
    expect((await verify(sign(claims({ exp: NOW_S - 3600 })))).ok).toBe(false);
    // 30s past expiry is inside the 60s skew allowance and still fine.
    expect((await verify(sign(claims({ exp: NOW_S - 30 })))).ok).toBe(true);
    expect((await verify(sign(claims({ exp: NOW_S - 120 })))).ok).toBe(false);
  });

  it('rejects a token with no exp at all', async () => {
    const withoutExp = claims();
    delete withoutExp.exp;
    expect((await verify(sign(withoutExp))).ok).toBe(false);
  });

  it('rejects a token with no email claim', async () => {
    const withoutEmail = claims();
    delete withoutEmail.email;
    const result = await verify(sign(withoutEmail));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('email');
  });

  it('fails closed when the key endpoint is unreachable', async () => {
    const fetchImpl = (async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    const result = await verify(sign(claims()), { fetchImpl });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('signing keys');
  });

  it('fails closed when no audience is configured', async () => {
    const result = await verify(sign(claims()), { audience: '' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('CF_ACCESS_AUD');
  });

  it('tries other published keys when the kid does not match', async () => {
    // Cloudflare rotates keys and publishes the next one ahead of time, so a
    // token can legitimately name a kid we have not seen. Refusing on kid alone
    // would lock the operator out mid-rotation.
    const server = keyServer([jwkOf(other.publicKey, 'kid-old'), jwkOf(publicKey, 'kid-new')]);
    const result = await verify(sign(claims(), { kid: 'kid-unknown' }), {
      fetchImpl: server.fetchImpl,
    });
    expect(result.ok).toBe(true);
  });

  it('caches the key set rather than fetching per request', async () => {
    const server = keyServer();
    await verify(sign(claims()), { fetchImpl: server.fetchImpl });
    await verify(sign(claims()), { fetchImpl: server.fetchImpl });
    await verify(sign(claims()), { fetchImpl: server.fetchImpl });
    expect(server.calls()).toBe(1);
  });
});
