// The worker's view of the shared composer.
//
// The composition itself lives in @probe/core (composeMessage), because
// apps/web has to produce byte-identical output for the queue's raw .eml
// preview and the two applications cannot import each other. All this file
// does is map database rows onto that input, so there is exactly one place
// where the footer, the click rewrite and the lint can be got wrong.

import { composeMessage, describeLint, type LintResult, type OutboundMessage } from '@probe/core';
import type { CampaignRow, ContactRow, LeadRow, ProofRow } from '@probe/db';

export { describeLint };

export interface RenderedSend {
  message: OutboundMessage;
  mime: string;
  lint: LintResult;
}

export interface RenderSendArgs {
  proof: ProofRow;
  lead: LeadRow;
  campaign: CampaignRow;
  contact: ContactRow;
  unsubToken: string;
  clickToken: string;
  baseUrl: string;
  postalAddress: string;
}

export function renderSend(args: RenderSendArgs): RenderedSend {
  const { proof, lead, campaign, contact } = args;

  const composed = composeMessage({
    subject: proof.subject ?? '',
    html: proof.html ?? '',
    text: proof.text_body ?? '',
    evidenceUrl: proof.evidence_url,
    productName: campaign.product,
    recipientDomain: lead.domain,
    fromName: campaign.from_name,
    fromEmail: campaign.from_email,
    replyTo: campaign.reply_to,
    to: contact.email ?? '',
    postalAddress: args.postalAddress,
    baseUrl: args.baseUrl,
    unsubToken: args.unsubToken,
    clickToken: args.clickToken,
  });

  return { message: composed.message, mime: composed.mime, lint: composed.lint };
}
