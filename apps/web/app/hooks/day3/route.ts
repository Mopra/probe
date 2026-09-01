import { logger } from '@probe/config';
import {
  DAY3_SIGNATURE_HEADER,
  hashEmail,
  normalizeEmail,
  parseDay3Event,
  verifyDay3Signature,
} from '@probe/core';
import {
  addSuppression,
  getSendByProviderEmailId,
  insertEvent,
  setSendProviderMessageId,
} from '@probe/db';
import { tryEnv } from '../../lib/probe';

export const dynamic = 'force-dynamic';

const log = logger('web:hooks:day3');

/**
 * §8.7. Day3 posts here for every delivery, bounce, complaint and failure on a
 * message probe sent, plus its own suppression events. This replaced the SES
 * delivery notifications: probe no longer owns an SES account, so the provider
 * boundary is Day3's API in one direction and its webhook in the other.
 *
 * The signature check is the entire security boundary around suppression
 * writes. It fails closed on a missing secret, because the URL is not a secret
 * and an unsigned-accepting endpoint would let anyone who found it suppress
 * arbitrary addresses -- a denial-of-leads that would be invisible, since a
 * suppressed lead looks exactly like a lead that opted out.
 *
 * Status codes: 200 for anything verified and understood, so Day3 stops
 * retrying; 500 only for a database failure, which is worth a retry; 403 for a
 * signature that does not verify.
 */
export async function POST(req: Request): Promise<Response> {
  // The raw bytes, before any parsing: the signature is over exactly these.
  const raw = await req.text();

  const secret = tryEnv()?.DAY3_WEBHOOK_SECRET ?? null;
  if (!secret) {
    log.error('rejected a Day3 webhook: DAY3_WEBHOOK_SECRET is not set');
    return text(403, 'Webhook secret is not configured.');
  }

  const verified = verifyDay3Signature({
    header: req.headers.get(DAY3_SIGNATURE_HEADER),
    secret,
    rawBody: raw,
  });
  if (!verified) {
    log.warn('rejected a Day3 webhook with an invalid signature');
    return text(403, 'Signature verification failed.');
  }

  const event = parseDay3Event(raw);
  if (event.type === 'unknown') {
    // A type probe does not handle is not an error. 200 so Day3 does not retry
    // it forever, and logged at info so a new event type is visible rather than
    // silently dropped.
    log.info('ignoring a Day3 event type probe does not handle', { detail: event.detail });
    return text(200, 'Ignored.');
  }

  try {
    await record(event);
  } catch (err) {
    log.error('failed to record a Day3 event', { type: event.type, error: String(err) });
    return text(500, 'Could not record the event.');
  }

  return text(200, 'Recorded.');
}

async function record(event: ReturnType<typeof parseDay3Event>): Promise<void> {
  const send = event.emailId ? await getSendByProviderEmailId(event.emailId) : null;

  if (!send && event.type !== 'suppression') {
    // An event for a message probe did not send. Day3 carries exit1's mail on
    // the same account, so this is expected traffic if one endpoint is
    // subscribed for both; recorded unattributed rather than dropped.
    log.info('Day3 event did not match a probe send', {
      type: event.type,
      emailId: event.emailId,
    });
  }

  // The SES message id arrives with the first event, not at send time, so this
  // is where the send row gets it. Useful for looking a message up in SES
  // itself when a deliverability question comes up.
  if (send && event.providerMessageId) {
    await setSendProviderMessageId(send.id, event.providerMessageId);
  }

  await insertEvent({
    send_id: send?.id ?? null,
    type: event.type,
    detail: { ...event.detail, email: event.email },
  });

  if (!event.suppress) return;

  // §3.1 rule 2. A hard bounce or any complaint suppresses immediately, and it
  // is global and permanent. addSuppression also scrubs the plaintext address.
  //
  // The hash comes from the send row when there is one. That is the hash that
  // passed the contact-once index, computed from the address probe actually
  // resolved, so it is right by construction. Re-hashing the address Day3
  // reports is the fallback, and it can differ (a +tag, a different case), which
  // is exactly why the send row is preferred.
  const reason = event.reason ?? 'bounced';
  const hashes = new Set<string>();
  if (send) hashes.add(send.email_hash);
  if (event.email) {
    const fromAddress = hashOf(event.email);
    if (fromAddress) hashes.add(fromAddress);
  }

  if (hashes.size === 0) {
    log.error('a suppressing Day3 event could not be attributed to any address', {
      type: event.type,
      emailId: event.emailId,
    });
    return;
  }

  for (const email_hash of hashes) {
    await addSuppression({ email_hash, reason, detail: `day3 ${event.type}` });
  }
  log.info('suppressed on a Day3 event', {
    type: event.type,
    reason,
    bounceType: event.bounceType,
    count: hashes.size,
  });
}

function hashOf(address: string): string | null {
  const env = tryEnv();
  if (!env?.PROBE_HASH_PEPPER) return null;
  const norm = normalizeEmail(address);
  return norm ? hashEmail(norm, env.PROBE_HASH_PEPPER) : null;
}

function text(status: number, body: string): Response {
  return new Response(`${body}\n`, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  });
}
