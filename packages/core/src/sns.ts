import { createVerify } from 'node:crypto';

// PLAN.md 8.7. The SNS webhook is a public, unauthenticated endpoint, so the
// signature check below is the entire security boundary around suppression
// writes. Everything here is deliberately strict.

export interface SnsEnvelope {
  Type: string;
  MessageId: string;
  TopicArn?: string;
  Subject?: string;
  Message: string;
  Timestamp: string;
  SignatureVersion: string;
  Signature: string;
  SigningCertURL: string;
  SubscribeURL?: string;
  Token?: string;
}

/**
 * Field order is fixed by AWS: alphabetical by key, and Subject is included
 * only when it is present. Getting this wrong fails closed (the signature will
 * not verify), but it fails closed on every legitimate message too, so it is
 * tested directly.
 */
const NOTIFICATION_FIELDS = ['Message', 'MessageId', 'Subject', 'Timestamp', 'TopicArn', 'Type'] as const;
const CONFIRMATION_FIELDS = [
  'Message',
  'MessageId',
  'SubscribeURL',
  'Timestamp',
  'Token',
  'TopicArn',
  'Type',
] as const;

/** Exported for tests: the exact bytes the signature is computed over. */
export function snsCanonicalString(env: SnsEnvelope): string | null {
  const type = env?.Type;
  let fields: readonly string[];
  if (type === 'Notification') {
    fields = NOTIFICATION_FIELDS;
  } else if (type === 'SubscriptionConfirmation' || type === 'UnsubscribeConfirmation') {
    fields = CONFIRMATION_FIELDS;
  } else {
    return null;
  }

  let out = '';
  for (const field of fields) {
    const value = (env as unknown as Record<string, unknown>)[field];
    // Subject is optional and is omitted entirely when absent, not sent empty.
    if (field === 'Subject' && (value === undefined || value === null)) continue;
    if (value === undefined || value === null) return null;
    out += `${field}\n${String(value)}\n`;
  }
  return out;
}

/**
 * Only AWS's own SNS hosts may serve the signing certificate. Without this
 * check an attacker points SigningCertURL at a certificate they control and
 * forges any notification they like, which would let them write suppressions
 * or fake deliveries at will.
 */
export function isValidSigningCertUrl(url: string): boolean {
  if (typeof url !== 'string' || url.trim().length === 0) return false;
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  if (parsed.port !== '') return false;
  // Credentials in the URL are never present on a real SNS cert URL and are a
  // classic way to make a hostile URL read as a friendly one.
  if (parsed.username !== '' || parsed.password !== '') return false;
  const host = parsed.hostname.toLowerCase();
  const ok = /^sns\.[a-z0-9-]+\.amazonaws\.com$/.test(host) || /^sns\.[a-z0-9-]+\.amazonaws\.com\.cn$/.test(host);
  if (!ok) return false;
  return parsed.pathname.toLowerCase().endsWith('.pem');
}

const certCache = new Map<string, string>();

/** Test seam. The cache is module level and would otherwise leak between tests. */
export function clearSnsCertCache(): void {
  certCache.clear();
}

async function fetchCert(url: string, doFetch: typeof fetch): Promise<string | null> {
  const cached = certCache.get(url);
  if (cached !== undefined) return cached;
  try {
    const res = await doFetch(url);
    if (!res.ok) return null;
    const pem = await res.text();
    if (!pem.includes('BEGIN CERTIFICATE')) return null;
    certCache.set(url, pem);
    return pem;
  } catch {
    return null;
  }
}

/**
 * Verifies the SHA1withRSA (SignatureVersion 1) or SHA256withRSA (version 2)
 * signature over the canonical string, after checking SigningCertURL is https
 * on an SNS host. Caches fetched certificates in memory. Never throws.
 */
export async function verifySnsSignature(env: SnsEnvelope, fetchImpl?: typeof fetch): Promise<boolean> {
  if (!env || typeof env !== 'object') return false;

  let algorithm: string;
  if (env.SignatureVersion === '1') {
    algorithm = 'RSA-SHA1';
  } else if (env.SignatureVersion === '2') {
    algorithm = 'RSA-SHA256';
  } else {
    // An unrecognised version is not something to guess at.
    return false;
  }

  if (typeof env.Signature !== 'string' || env.Signature.length === 0) return false;
  if (!isValidSigningCertUrl(env.SigningCertURL)) return false;

  const canonical = snsCanonicalString(env);
  if (canonical === null) return false;

  const doFetch = fetchImpl ?? globalThis.fetch;
  if (typeof doFetch !== 'function') return false;

  const pem = await fetchCert(env.SigningCertURL, doFetch);
  if (pem === null) return false;

  try {
    const verifier = createVerify(algorithm);
    verifier.update(canonical, 'utf8');
    verifier.end();
    return verifier.verify(pem, env.Signature, 'base64');
  } catch {
    return false;
  }
}

export type SesEventKind =
  | 'delivery'
  | 'bounce'
  | 'complaint'
  | 'send'
  | 'reject'
  | 'inbound'
  | 'open'
  | 'click'
  | 'unknown';

export interface SesEvent {
  kind: SesEventKind;
  messageId: string | null;
  recipients: string[];
  /** hard bounce or any complaint: suppress immediately */
  suppress: boolean;
  reason: 'bounced' | 'complained' | null;
  detail: Record<string, unknown>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Pulls emailAddress out of a bouncedRecipients / complainedRecipients list. */
function recipientAddresses(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry === 'string') {
      out.push(entry);
      continue;
    }
    const rec = asRecord(entry);
    const address = rec ? asString(rec['emailAddress']) : null;
    if (address) out.push(address);
  }
  return out;
}

function destinations(mail: Record<string, unknown> | null): string[] {
  if (!mail) return [];
  const dest = mail['destination'];
  return Array.isArray(dest) ? dest.filter((d): d is string => typeof d === 'string') : [];
}

const KIND_BY_TYPE: Record<string, SesEventKind> = {
  bounce: 'bounce',
  complaint: 'complaint',
  delivery: 'delivery',
  send: 'send',
  reject: 'reject',
  open: 'open',
  click: 'click',
  received: 'inbound',
};

const UNKNOWN: SesEvent = {
  kind: 'unknown',
  messageId: null,
  recipients: [],
  suppress: false,
  reason: null,
  detail: {},
};

/**
 * Parses the JSON inside SnsEnvelope.Message into a normalized SesEvent.
 * Understands the SES notification shape (notificationType), the event
 * publishing shape (eventType) and the inbound receipt shape. Anything
 * unrecognised is kind 'unknown' with suppress false, never a throw: a webhook
 * that throws on an unexpected payload is a webhook that retries forever.
 */
export function parseSesMessage(message: string): SesEvent {
  if (typeof message !== 'string' || message.trim().length === 0) return { ...UNKNOWN };

  let parsed: unknown;
  try {
    parsed = JSON.parse(message);
  } catch {
    return { ...UNKNOWN };
  }

  const root = asRecord(parsed);
  if (!root) return { ...UNKNOWN };

  const mail = asRecord(root['mail']);
  const messageId = mail ? asString(mail['messageId']) : null;
  const receipt = asRecord(root['receipt']);

  const rawType =
    asString(root['notificationType']) ?? asString(root['eventType']) ?? (receipt && mail ? 'Received' : null);
  const kind = rawType ? KIND_BY_TYPE[rawType.toLowerCase()] : undefined;

  if (!kind) {
    return { ...UNKNOWN, messageId, detail: rawType ? { type: rawType } : {} };
  }

  if (kind === 'bounce') {
    const bounce = asRecord(root['bounce']);
    const bounceType = bounce ? asString(bounce['bounceType']) : null;
    // Only a permanent (hard) bounce suppresses. A transient bounce is a full
    // mailbox or a greylist, and suppressing on that throws away a real lead.
    const permanent = bounceType === 'Permanent';
    const recipients = bounce ? recipientAddresses(bounce['bouncedRecipients']) : [];
    return {
      kind,
      messageId,
      recipients: recipients.length > 0 ? recipients : destinations(mail),
      suppress: permanent,
      reason: permanent ? 'bounced' : null,
      detail: {
        bounceType,
        bounceSubType: bounce ? asString(bounce['bounceSubType']) : null,
        timestamp: bounce ? asString(bounce['timestamp']) : null,
        feedbackId: bounce ? asString(bounce['feedbackId']) : null,
      },
    };
  }

  if (kind === 'complaint') {
    const complaint = asRecord(root['complaint']);
    const recipients = complaint ? recipientAddresses(complaint['complainedRecipients']) : [];
    return {
      kind,
      messageId,
      recipients: recipients.length > 0 ? recipients : destinations(mail),
      // Every complaint suppresses, no exceptions. A complaint rate above
      // 0.1% is what gets an SES account throttled (5.1).
      suppress: true,
      reason: 'complained',
      detail: {
        complaintFeedbackType: complaint ? asString(complaint['complaintFeedbackType']) : null,
        timestamp: complaint ? asString(complaint['timestamp']) : null,
        feedbackId: complaint ? asString(complaint['feedbackId']) : null,
      },
    };
  }

  if (kind === 'inbound') {
    const recipients = receipt
      ? (Array.isArray(receipt['recipients'])
          ? (receipt['recipients'] as unknown[]).filter((r): r is string => typeof r === 'string')
          : [])
      : [];
    const action = receipt ? asRecord(receipt['action']) : null;
    return {
      kind,
      messageId,
      recipients: recipients.length > 0 ? recipients : destinations(mail),
      suppress: false,
      reason: null,
      detail: {
        spamVerdict: receipt ? asRecord(receipt['spamVerdict'])?.['status'] ?? null : null,
        virusVerdict: receipt ? asRecord(receipt['virusVerdict'])?.['status'] ?? null : null,
        dkimVerdict: receipt ? asRecord(receipt['dkimVerdict'])?.['status'] ?? null : null,
        spfVerdict: receipt ? asRecord(receipt['spfVerdict'])?.['status'] ?? null : null,
        bucketName: action ? asString(action['bucketName']) : null,
        objectKey: action ? asString(action['objectKey']) : null,
        commonHeaders: mail ? asRecord(mail['commonHeaders']) : null,
      },
    };
  }

  const sub = asRecord(root[kind]) ?? asRecord(root[`${kind}Object`]);
  return {
    kind,
    messageId,
    recipients: destinations(mail),
    suppress: false,
    reason: null,
    detail: {
      timestamp: sub ? asString(sub['timestamp']) : null,
      processingTimeMillis: sub ? sub['processingTimeMillis'] ?? null : null,
      smtpResponse: sub ? asString(sub['smtpResponse']) : null,
      reason: sub ? asString(sub['reason']) : null,
    },
  };
}
