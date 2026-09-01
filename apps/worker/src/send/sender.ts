// The only two things in probe that can put bytes on a wire addressed to a
// human, and the switch between them.
//
// §3.1 rule 4: dry-run is the default. createSender() returns the Day3 sender
// only when PROBE_SEND_ENABLED parses to exactly true. In every other case the
// dry-run sender is returned and no API key is read, no network call is made,
// and nothing can leave.
//
// probe used to hold AWS credentials and hand raw MIME to SESv2. It no longer
// does (§5.1): Day3 owns the SES account, the verified domains and the
// reputation, and probe is one more caller of its transactional API. The
// consequence worth being explicit about is that Day3 assembles the MIME
// envelope, so `mime` on an OutboundSend is a faithful PREVIEW of the message
// (subject, both bodies and the unsubscribe target are byte-identical to what
// is sent) rather than the exact bytes on the wire. The dry-run sender writes
// that preview to ./outbox; the queue's "view raw .eml" shows the same thing.

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadEnv, logger } from '@probe/config';
import { day3Send, Day3SendError } from './day3';
import { outboxDir, sendEnabled } from './runtime';

const log = logger('send.sender');

/**
 * Everything a sender needs. The parts are what actually gets sent; `mime` is
 * the preview, and only the dry-run sender reads it.
 */
export interface OutboundSend {
  fromName: string;
  fromEmail: string;
  replyTo?: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  /** The /u/:token URL. Becomes the RFC 8058 header pair at the provider. */
  unsubscribeUrl: string;
  /** RFC 5322 preview bytes, for ./outbox and the queue's raw view. */
  mime: string;
}

export interface SendMeta {
  sendId: string;
  campaignSlug?: string;
}

export interface SendReceipt {
  /** Day3's `eml_…`, or a synthetic id in dry-run. */
  providerEmailId: string;
  provider: 'dry-run' | 'day3';
}

export interface Sender {
  /** Which implementation this is. Exposed so the choice itself is assertable:
   *  "dry-run is the default" is the invariant most worth a test (§3.1 rule 4). */
  readonly kind: 'dry-run' | 'day3';
  send(message: OutboundSend, meta: SendMeta): Promise<SendReceipt>;
}

/**
 * Picks the sender. Dry-run whenever PROBE_SEND_ENABLED is not exactly true,
 * which includes a missing or unparseable env: failing to read configuration
 * can never be the thing that turns sending on.
 */
export function createSender(): Sender {
  if (!sendEnabled()) {
    log.info('sender: dry run', { reason: 'PROBE_SEND_ENABLED is not true' });
    return createDryRunSender();
  }
  log.warn('sender: LIVE, Day3 will receive real mail');
  return createDay3Sender();
}

/** Writes ${PROBE_OUTBOX_DIR}/<timestamp>-<sendId>.eml and returns a synthetic
 *  id, so every downstream code path (markSendSent, the events row, the CLI
 *  summary) behaves identically to a real send. */
export function createDryRunSender(dir?: string): Sender {
  return {
    kind: 'dry-run',
    async send(message: OutboundSend, meta: SendMeta): Promise<SendReceipt> {
      const target = dir ?? outboxDir();
      await fs.mkdir(target, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const file = path.join(target, `${stamp}-${safeName(meta.sendId)}.eml`);
      await fs.writeFile(file, message.mime, 'utf8');
      const providerEmailId = `dryrun-${randomUUID()}`;
      log.info('dry run send written', {
        file,
        to: message.to,
        sendId: meta.sendId,
        providerEmailId,
      });
      return { providerEmailId, provider: 'dry-run' };
    },
  };
}

/**
 * The real thing. The send id is the idempotency key, which is what makes an
 * ambiguous timeout safe to retry: Day3 replays the original response instead
 * of accepting a second message for the same founder (§3.2).
 */
export function createDay3Sender(): Sender {
  return {
    kind: 'day3',
    async send(message: OutboundSend, meta: SendMeta): Promise<SendReceipt> {
      const env = loadEnv();
      if (!env.DAY3_API_KEY) {
        // Reached only if the boot preflight was bypassed. Terminal, and it says
        // what to do rather than what went wrong.
        throw new Day3SendError(
          0,
          'no_api_key',
          'DAY3_API_KEY is not set. Run `cli preflight` before enabling sending.',
          false,
        );
      }

      const result = await day3Send(
        {
          apiKey: env.DAY3_API_KEY,
          baseUrl: env.DAY3_API_BASE_URL,
        },
        {
          from: message.fromName
            ? `${message.fromName} <${message.fromEmail}>`
            : message.fromEmail,
          to: message.to,
          subject: message.subject,
          html: message.html,
          text: message.text,
          replyTo: message.replyTo,
          listUnsubscribe: message.unsubscribeUrl,
          // Tags land on Day3's own log and on its webhooks, so a send can be
          // traced from either side without joining through probe's database.
          tags: {
            app: 'probe',
            send_id: meta.sendId,
            ...(meta.campaignSlug ? { campaign: meta.campaignSlug } : {}),
          },
        },
        meta.sendId,
      );

      log.info('sent via Day3', {
        sendId: meta.sendId,
        emailId: result.emailId,
        status: result.status,
      });
      return { providerEmailId: result.emailId, provider: 'day3' };
    },
  };
}

function safeName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64) || 'send';
}
