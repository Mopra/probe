// The single place the outbound bytes are composed.
//
// Everything that produces an email goes through here: the queue's "view raw
// .eml" and its pre-approval lint in apps/web, the dry-run harness, the
// generate job's pre-flight lint, and the send daemon in apps/worker. That is
// two applications that cannot import each other, which is exactly why this
// lives in core rather than in either of them. One composer means the bytes
// Morten approves are the bytes SES gets, and it means no single caller can
// forget the footer.
//
// probe never composes copy (§2, §6). The generator's html and text are
// carried byte for byte. The only modifications are the two the plan permits:
// the click rewrite (§8.7) and the footer (§9.2.7), in that order, followed by
// the lint on the composed result (§9.2.8).

import { applyFooter, clickUrl, dataNoticeUrl, renderFooter, rewriteEvidenceUrl, unsubscribeUrl } from './footer';
import { lintCopy, type LintResult } from './lint';
import { buildMime, type OutboundMessage } from './mime';

/** Plain values only, no database row types: core does not depend on
 *  @probe/db, and both callers already hold everything needed. */
export interface ComposeInput {
  /** Straight from the proof. */
  subject: string;
  html: string;
  text: string;
  evidenceUrl: string | null;
  /** campaigns.product, e.g. 'exit1.dev'. */
  productName: string;
  /**
   * leads.domain, the recipient's own domain. Urls on it are permitted in the
   * body alongside the three required links: they are the evidence the finding
   * is about, not a fourth funnel (§9.2.5, see LintInput.recipientDomain).
   */
  recipientDomain?: string | null;
  fromName: string;
  fromEmail: string;
  replyTo?: string | null;
  /** The recipient address. May be empty in a preview. */
  to: string;
  postalAddress: string;
  /** Public base url of apps/web, no trailing slash. */
  baseUrl: string;
  unsubToken: string;
  clickToken: string;
}

export interface ComposedMessage {
  subject: string;
  html: string;
  text: string;
  message: OutboundMessage;
  /** RFC 5322 bytes: what SES receives and what a .eml preview shows. */
  mime: string;
  lint: LintResult;
  links: {
    unsubscribe: string;
    click: string;
    dataNotice: string;
    /** Null when the generator returned no evidence url. */
    evidence: string | null;
  };
}

/** campaigns.product is written as a bare domain ('exit1.dev') but nothing
 *  stops it being a URL, and the lint wants a domain. Normalising here rather
 *  than trusting the column keeps a config typo from producing a lint failure
 *  that reads like a copy problem. */
export function productDomainOf(product: string): string {
  const host = product
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .replace(/^www\./, '');
  const firstSegment = host.split('/')[0] ?? host;
  return firstSegment.split(':')[0] ?? firstSegment;
}

export function composeMessage(input: ComposeInput): ComposedMessage {
  const unsub = unsubscribeUrl(input.baseUrl, input.unsubToken);
  const dataNotice = dataNoticeUrl(input.baseUrl);
  const click = clickUrl(input.baseUrl, input.clickToken);

  // 1. Start from the generator's bytes. No trimming, no reflowing, no
  //    templating. A proof missing a body is a bug upstream; the lint below
  //    turns it into a visible failure rather than an empty email.
  let html = input.html;
  let text = input.text;

  // 2. Point the evidence link at /c/:token so a click is recorded (§8.7).
  //    Only when the proof actually carries one: rewriting the empty string
  //    would splice the click url into every gap in the body.
  const evidence = input.evidenceUrl && input.evidenceUrl.length > 0 ? input.evidenceUrl : null;
  if (evidence) {
    const rewritten = rewriteEvidenceUrl({ html, text, evidenceUrl: evidence, clickUrl: click });
    html = rewritten.html;
    text = rewritten.text;
  }

  // 3. The footer is appended by probe, never by generators, and it is not
  //    optional (§6, §9.2.7). It carries the CAN-SPAM postal address, the
  //    one-click unsubscribe and the data notice.
  const footer = renderFooter({
    fromName: input.fromName,
    fromEmail: input.fromEmail,
    productName: input.productName,
    postalAddress: input.postalAddress,
    unsubscribeUrl: unsub,
    dataNoticeUrl: dataNotice,
  });
  const withFooter = applyFooter({ html, text, footer });
  html = withFooter.html;
  text = withFooter.text;

  // 4. Lint the composed result, not the raw proof: the footer elements and
  //    the permitted-link set only exist after step 3 (§9.2.8).
  const lint = lintCopy({
    subject: input.subject,
    html,
    text,
    productName: input.productName,
    productDomain: productDomainOf(input.productName),
    evidenceUrl: evidence ? click : '',
    unsubscribeUrl: unsub,
    dataNoticeUrl: dataNotice,
    postalAddress: input.postalAddress,
    fromName: input.fromName,
    fromEmail: input.fromEmail,
    recipientDomain: input.recipientDomain ?? null,
  });

  // 5. RFC 5322 bytes, with List-Unsubscribe and List-Unsubscribe-Post
  //    pointing at /u/:token (§9.3).
  const message: OutboundMessage = {
    fromName: input.fromName,
    fromEmail: input.fromEmail,
    to: input.to,
    replyTo: input.replyTo ?? undefined,
    subject: input.subject,
    html,
    text,
    unsubscribeUrl: unsub,
  };

  // The lint result is returned, never thrown. The caller decides what a
  // failure means: the harness prints it, generate drops the lead, approval
  // refuses, the sender refuses to dispatch. Throwing here would force all
  // four to agree on one reaction.
  return {
    subject: input.subject,
    html,
    text,
    message,
    mime: buildMime(message),
    lint,
    links: { unsubscribe: unsub, click, dataNotice, evidence },
  };
}

/** One-line rendering of a lint failure, for a log field or a proofs.error. */
export function describeLint(lint: LintResult): string {
  return lint.violations.map((v) => `${v.code}@${v.where}: ${v.message}`).join('; ');
}
