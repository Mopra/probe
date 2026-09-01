import { logger } from '@probe/config';
import {
  hashEmail,
  isAutomatedMessage,
  normalizeEmail,
  parseFromAddress,
  parseSesMessage,
  verifySnsSignature,
} from '@probe/core';
import type { Headers as MailHeaders, SesEvent, SnsEnvelope } from '@probe/core';
import { addSuppression, getSendBySesMessageId, hasLiveSend, insertEvent } from '@probe/db';
import type { SuppressionReason } from '@probe/db';
import { tryEnv } from '../../lib/probe';

export const dynamic = 'force-dynamic';

const log = logger('web:hooks:ses');

/**
 * §5.3. SNS posts here for INBOUND mail only.
 *
 * Delivery, bounce and complaint notifications used to arrive here too. They
 * now come from Day3 (/hooks/day3), because probe no longer owns an SES account
 * (§5.1). What SES still does for probe is receive: an inbound receipt rule on
 * the reply address writes to S3 and publishes to SNS, which posts here, and
 * this is where a genuine reply becomes a suppression. Day3 has no inbound
 * side, so this endpoint stays.
 *
 * A delivery-shaped notification arriving here is therefore either an old
 * subscription that has not been removed or a topic that should not be pointed
 * at this endpoint. It is recorded and reported rather than silently processed,
 * so the double-counting that would otherwise follow is visible.
 *
 * The rule for status codes: 200 for anything verified that we understood, so
 * SNS does not retry a poison payload forever, and 400 only for an envelope
 * that is not an SNS message at all.
 */
export async function POST(req: Request): Promise<Response> {
  // The raw body, before any parsing: the signature is over these bytes.
  const raw = await req.text();

  let envelope: SnsEnvelope;
  try {
    envelope = JSON.parse(raw) as SnsEnvelope;
  } catch {
    return text(400, 'Body is not JSON.');
  }
  if (!envelope || typeof envelope !== 'object' || typeof envelope.Type !== 'string') {
    return text(400, 'Not an SNS envelope.');
  }

  // The topic allowlist is mandatory, and this is why.
  //
  // A valid SNS signature only proves the message came from SNS. It does not
  // prove it came from OUR topic: anyone with an AWS account can create a topic,
  // subscribe this endpoint to it and post whatever they like, and every
  // signature will verify because the certificate really is Amazon's. Without
  // the ARN check, a stranger could post forged bounces and complaints for
  // arbitrary addresses, each of which writes a permanent suppression with no
  // resubscribe path (§3.1 rule 2). An empty allowlist used to mean "allow any
  // topic"; it now means "allow none".
  const env = tryEnv();
  const allowedArns = env?.SNS_ALLOWED_TOPIC_ARNS ?? [];
  if (allowedArns.length === 0) {
    log.error('rejected an SNS message: SNS_ALLOWED_TOPIC_ARNS is empty', {
      topic_arn: envelope.TopicArn ?? null,
    });
    return text(403, 'No SNS topic is allowlisted on this deployment.');
  }
  if (!envelope.TopicArn || !allowedArns.includes(envelope.TopicArn)) {
    log.warn('rejected an SNS message from a topic that is not allowlisted', {
      topic_arn: envelope.TopicArn ?? null,
    });
    return text(403, 'Topic not allowed.');
  }

  let verified = false;
  try {
    verified = await verifySnsSignature(envelope);
  } catch (err) {
    log.error('signature verification threw', { error: String(err) });
  }
  if (!verified) {
    log.warn('rejected an SNS message with an invalid signature', {
      message_id: envelope.MessageId ?? null,
      topic_arn: envelope.TopicArn ?? null,
    });
    return text(403, 'Signature verification failed.');
  }

  if (envelope.Type === 'SubscriptionConfirmation') {
    return confirmSubscription(envelope);
  }

  if (envelope.Type === 'UnsubscribeConfirmation') {
    log.warn('SNS says this endpoint was unsubscribed from a topic', {
      topic_arn: envelope.TopicArn ?? null,
    });
    return text(200, 'Noted.');
  }

  if (envelope.Type !== 'Notification') {
    log.info('ignoring an SNS message type probe does not handle', { type: envelope.Type });
    return text(200, 'Ignored.');
  }

  if (typeof envelope.Message !== 'string') {
    return text(400, 'Notification has no Message.');
  }

  let event: SesEvent;
  try {
    event = parseSesMessage(envelope.Message);
  } catch (err) {
    log.error('could not parse the SES message', { error: String(err) });
    return text(200, 'Unparseable message, not retrying.');
  }

  try {
    if (event.kind === 'inbound') {
      await handleInbound(event);
    } else {
      await handleUnexpectedNotification(event);
    }
  } catch (err) {
    // A 500 here means SNS retries, which is right for a transient database
    // failure and is the reason this is not swallowed into a 200.
    log.error('failed to record an SES event', { kind: event.kind, error: String(err) });
    return text(500, 'Could not record the event.');
  }

  return text(200, 'Recorded.');
}

async function confirmSubscription(envelope: SnsEnvelope): Promise<Response> {
  const url = envelope.SubscribeURL;
  if (!url) {
    log.warn('subscription confirmation arrived without a SubscribeURL');
    return text(200, 'Nothing to confirm.');
  }
  // Logged as well as fetched: if the fetch fails, the url is in the log and
  // the subscription can be confirmed by hand.
  log.info('confirming an SNS subscription', { topic_arn: envelope.TopicArn ?? null, url });
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    log.info('subscription confirmation fetched', { status: res.status });
  } catch (err) {
    log.error('subscription confirmation fetch failed, confirm this url by hand', {
      url,
      error: String(err),
    });
  }
  return text(200, 'Subscription confirmation handled.');
}

/**
 * A delivery-shaped notification on the inbound endpoint. Since §5.1, these
 * belong to /hooks/day3.
 *
 * It is still recorded, because throwing away a real bounce would be worse than
 * recording it twice, and it still suppresses, because a hard bounce or a
 * complaint must never be dropped on a routing technicality. But it is logged
 * at error level: a topic publishing delivery events to this endpoint should be
 * unsubscribed, and until it is, /health's rates are counting some events twice.
 */
async function handleUnexpectedNotification(event: SesEvent): Promise<void> {
  log.error('an SES delivery notification arrived on the inbound endpoint', {
    kind: event.kind,
    ses_message_id: event.messageId,
    note:
      'delivery events come from Day3 (/hooks/day3) since §5.1. Unsubscribe this topic from ' +
      '/hooks/ses, or the rates on /health will double count.',
  });

  const send = event.messageId ? await getSendBySesMessageId(event.messageId) : null;

  await insertEvent({
    send_id: send?.id ?? null,
    type: event.kind,
    detail: {
      ...event.detail,
      ses_message_id: event.messageId,
      recipients: event.recipients,
      via: 'hooks/ses (unexpected)',
    },
  });

  if (!event.suppress) return;

  // §3.1 rule 2. A hard bounce or any complaint suppresses immediately, and it
  // is global and permanent. addSuppression also scrubs the plaintext address.
  const reason: SuppressionReason = event.reason ?? 'bounced';
  const hashes = new Set<string>();
  if (send) hashes.add(send.email_hash);
  for (const hash of hashRecipients(event.recipients)) hashes.add(hash);

  if (hashes.size === 0) {
    log.error('a suppressing event could not be attributed to any address', {
      kind: event.kind,
      ses_message_id: event.messageId,
    });
    return;
  }

  for (const email_hash of hashes) {
    await addSuppression({ email_hash, reason, detail: event.kind });
  }
  log.info('suppressed on an SES event', { kind: event.kind, reason, count: hashes.size });
}

/**
 * §5.3, in exactly this order.
 *   1. filter automated mail: forwarded, but never suppresses and never counts
 *      as a reply. An out of office must not burn a contact or inflate the one
 *      metric that matters.
 *   2. a genuine reply inserts the suppression before anything else happens.
 *   3. forward to the real inbox either way.
 */
async function handleInbound(event: SesEvent): Promise<void> {
  const headers = extractHeaders(event.detail);
  const automated = isAutomatedMessage(headers);
  const from = parseFromAddress(headerValue(headers, 'from'));
  const norm = from ? normalizeEmail(from) : null;
  const forwardTo = tryEnv()?.REPLY_FORWARD_TO ?? null;

  // TODO(§5.3 step 3): forward the message to REPLY_FORWARD_TO. apps/worker
  // owns every path that talks to SES, and this app has no SES client by
  // design, so the intent is recorded on the event and the worker picks it up.
  // Doing it here would put outbound sending inside the app that must never be
  // down, for a job that can wait a minute.
  const forward = { forward_to: forwardTo, forwarded: false };

  if (automated) {
    await insertEvent({
      send_id: null,
      type: 'inbound',
      detail: { ...event.detail, automated: true, from: norm, ...forward },
    });
    log.info('automated inbound mail, not a reply and not a suppression', { from: norm });
    return;
  }

  if (!norm) {
    await insertEvent({
      send_id: null,
      type: 'inbound',
      detail: { ...event.detail, automated: false, from: null, ...forward },
    });
    log.warn('inbound mail with no usable From address, cannot suppress');
    return;
  }

  const pepper = tryEnv()?.PROBE_HASH_PEPPER;
  if (!pepper) {
    log.error('cannot hash a reply address, PROBE_HASH_PEPPER is unreadable');
    throw new Error('PROBE_HASH_PEPPER unavailable');
  }
  const emailHash = hashEmail(norm, pepper);

  // Suppression first, before the reply event, before anything else (§5.3).
  await addSuppression({ email_hash: emailHash, reason: 'replied', detail: 'inbound reply' });

  const hadLiveSend = await hasLiveSend(emailHash);
  const send = event.messageId ? await getSendBySesMessageId(event.messageId) : null;

  await insertEvent({
    send_id: send?.id ?? null,
    type: 'reply',
    detail: { ...event.detail, automated: false, had_live_send: hadLiveSend, ...forward },
  });

  log.info('genuine reply, suppressed and recorded', { had_live_send: hadLiveSend });
}

function hashRecipients(recipients: string[]): string[] {
  const pepper = tryEnv()?.PROBE_HASH_PEPPER;
  if (!pepper) return [];
  const out: string[] = [];
  for (const raw of recipients) {
    const norm = normalizeEmail(raw);
    if (norm) out.push(hashEmail(norm, pepper));
  }
  return out;
}

/**
 * SES puts headers on an inbound receipt in more than one shape depending on
 * the notification version, so accept all of them and give isAutomatedMessage
 * a plain record either way.
 */
function extractHeaders(detail: Record<string, unknown>): MailHeaders {
  const candidates: unknown[] = [
    detail.headers,
    (detail.mail as Record<string, unknown> | undefined)?.headers,
    detail.commonHeaders,
    (detail.mail as Record<string, unknown> | undefined)?.commonHeaders,
  ];

  const merged: MailHeaders = {};
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (Array.isArray(candidate)) {
      for (const entry of candidate) {
        if (!entry || typeof entry !== 'object') continue;
        const name = (entry as { name?: unknown }).name;
        const value = (entry as { value?: unknown }).value;
        if (typeof name === 'string' && typeof value === 'string') {
          const key = name.toLowerCase();
          const existing = merged[key];
          if (existing === undefined) merged[key] = value;
          else if (Array.isArray(existing)) existing.push(value);
          else merged[key] = [existing, value];
        }
      }
    } else if (typeof candidate === 'object') {
      for (const [name, value] of Object.entries(candidate as Record<string, unknown>)) {
        const key = name.toLowerCase();
        if (merged[key] !== undefined) continue;
        if (typeof value === 'string') merged[key] = value;
        else if (Array.isArray(value) && value.every((v) => typeof v === 'string')) {
          merged[key] = value as string[];
        }
      }
    }
  }
  return merged;
}

function headerValue(headers: MailHeaders, name: string): string | undefined {
  const value = headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0];
  return value;
}

function text(status: number, body: string): Response {
  return new Response(`${body}\n`, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  });
}
