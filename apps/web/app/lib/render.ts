import { composeMessage, newToken } from '@probe/core';
import type { LintResult } from '@probe/core';
import type { QueueItem } from '@probe/db';
import { baseUrl, getConfig, tryConfig } from './probe';

export interface RenderedProof {
  subject: string;
  html: string;
  text: string;
  lint: LintResult;
  tokens: { unsub: string; click: string };
  links: {
    unsubscribe: string;
    click: string;
    dataNotice: string;
    evidence: string | null;
  };
}

/**
 * Compose exactly what the sender composes: the generator body, the evidence
 * url rewritten through /c/:token (§8.7), then the footer appended (§9.2.7),
 * then the lint (§9.2.8).
 *
 * The composition lives in @probe/core so this app and apps/worker cannot
 * drift. That matters more than it looks: the point of "view raw .eml" is that
 * the bytes Morten inspects are the bytes that go out, and the point of the
 * lint is that it blocks approval on the same grounds it blocks dispatch.
 * This function only maps a queue row onto the composer's input.
 */
export function renderProof(
  item: QueueItem,
  tokens?: { unsub: string; click: string },
): RenderedProof {
  const cfg = tryConfig();
  const postalAddress = cfg?.global.postal_address ?? '';

  // A preview mints throwaway tokens. The real ones are created at approval
  // and differ only in their random bytes, so the rendered result is the same
  // email in every respect that the lint or a reader can see.
  const pair = tokens ?? { unsub: newToken(), click: newToken() };

  const composed = composeMessage({
    subject: item.proof.subject ?? '',
    html: item.proof.html ?? '',
    text: item.proof.text_body ?? '',
    evidenceUrl: item.proof.evidence_url,
    productName: item.campaign.product,
    recipientDomain: item.lead.domain,
    fromName: item.campaign.from_name,
    fromEmail: item.campaign.from_email,
    replyTo: item.campaign.reply_to,
    to: item.contact.email ?? '',
    postalAddress,
    baseUrl: baseUrl(),
    unsubToken: pair.unsub,
    clickToken: pair.click,
  });

  return {
    subject: composed.subject,
    html: composed.html,
    text: composed.text,
    lint: composed.lint,
    tokens: pair,
    links: composed.links,
  };
}

/**
 * The same composition, run through buildMime. This is the exact RFC 5322
 * message the send daemon hands to SES, minus the message id and date it will
 * stamp at dispatch time.
 */
export function renderEml(item: QueueItem, tokens?: { unsub: string; click: string }): string {
  // getConfig, not tryConfig: a raw .eml built without the real postal address
  // would be a misleading preview of a CAN-SPAM required field.
  const cfg = getConfig();
  const pair = tokens ?? { unsub: newToken(), click: newToken() };
  const recipient = item.contact.email ?? item.contact.email_norm;

  return composeMessage({
    subject: item.proof.subject ?? '',
    html: item.proof.html ?? '',
    text: item.proof.text_body ?? '',
    evidenceUrl: item.proof.evidence_url,
    productName: item.campaign.product,
    recipientDomain: item.lead.domain,
    fromName: item.campaign.from_name,
    fromEmail: item.campaign.from_email,
    replyTo: item.campaign.reply_to,
    // A scrubbed contact means a suppression landed between generation and
    // now. The preview still renders, so the operator can see what would have
    // gone out, but it can never address a real inbox.
    to: recipient ?? 'scrubbed@invalid',
    postalAddress: cfg.global.postal_address,
    baseUrl: baseUrl(),
    unsubToken: pair.unsub,
    clickToken: pair.click,
  }).mime;
}
