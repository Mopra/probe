/**
 * The footer (§9.2.7, §8.7).
 *
 * Appended by probe, never by generators. It carries the four things probe is
 * accountable for: who sent this and from which address, the physical postal
 * address CAN-SPAM requires, the one click unsubscribe, and the data notice
 * that backs the GDPR Article 14 obligation. The contact once statement
 * (§9.2.6) is repeated here as well as in the body, because the footer is the
 * part probe controls and a generator cannot drop it.
 *
 * The copy is deliberately flat. No sign off, no closing question, no fourth
 * link, nothing that reads as an offer, so that lintCopy passes on it.
 *
 * Layout note: the postal address is the FIRST line of the footer, in both
 * variants. lintCopy finds the footer boundary by looking for the earliest
 * footer marker and pulling back to the start of its line, so anything placed
 * above the postal address would be counted as body and would break the
 * "exactly one product mention" rule.
 */

export interface FooterInput {
  fromName: string;
  fromEmail: string;
  productName: string;
  postalAddress: string;
  unsubscribeUrl: string;
  dataNoticeUrl: string;
}

const CONTACT_ONCE_LINE = 'This is the only email you will ever get from me. No follow-ups, no sequence.';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeAttribute(value: string): string {
  return escapeHtml(value);
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripTrailingSlash(base: string): string {
  return base.replace(/\/+$/, '');
}

const FOOTER_WRAPPER_STYLE = [
  'margin-top:28px',
  'padding-top:12px',
  'border-top:1px solid #e2e2e2',
  'font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif',
  'font-size:12px',
  'line-height:1.55',
  'color:#767676',
].join(';');

const FOOTER_LINE_STYLE = 'margin:0 0 4px;color:#767676;';
const FOOTER_LAST_LINE_STYLE = 'margin:0;color:#767676;';
const FOOTER_LINK_STYLE = 'color:#767676;text-decoration:underline;';

export function renderFooter(input: FooterInput): { html: string; text: string } {
  const dataNoticeLabel = `How ${input.productName} got your address, and how to have it deleted`;

  const text = [
    input.postalAddress,
    `${input.fromName}, ${input.fromEmail}`,
    CONTACT_ONCE_LINE,
    `Unsubscribe: ${input.unsubscribeUrl}`,
    `${dataNoticeLabel}: ${input.dataNoticeUrl}`,
  ].join('\n');

  const html = [
    `<div style="${FOOTER_WRAPPER_STYLE}">`,
    `<p style="${FOOTER_LINE_STYLE}">${escapeHtml(input.postalAddress)}</p>`,
    `<p style="${FOOTER_LINE_STYLE}">${escapeHtml(input.fromName)}, ${escapeHtml(input.fromEmail)}</p>`,
    `<p style="${FOOTER_LINE_STYLE}">${escapeHtml(CONTACT_ONCE_LINE)}</p>`,
    `<p style="${FOOTER_LINE_STYLE}"><a href="${escapeAttribute(input.unsubscribeUrl)}" style="${FOOTER_LINK_STYLE}">Unsubscribe</a></p>`,
    `<p style="${FOOTER_LAST_LINE_STYLE}"><a href="${escapeAttribute(input.dataNoticeUrl)}" style="${FOOTER_LINK_STYLE}">${escapeHtml(dataNoticeLabel)}</a></p>`,
    `</div>`,
  ].join('\n');

  return { html, text };
}

/**
 * Appends the footer to a generator body. The html footer is injected before
 * the last </body> when there is one, appended otherwise. Neither input is
 * mutated.
 */
export function applyFooter(args: {
  html: string;
  text: string;
  footer: { html: string; text: string };
}): { html: string; text: string } {
  const { html, text, footer } = args;

  const closingBody = html.toLowerCase().lastIndexOf('</body>');
  const nextHtml =
    closingBody >= 0
      ? `${html.slice(0, closingBody)}\n${footer.html}\n${html.slice(closingBody)}`
      : `${html}\n${footer.html}\n`;

  const nextText = `${text.replace(/\s+$/, '')}\n\n${footer.text}\n`;

  return { html: nextHtml, text: nextText };
}

/**
 * Rewrites every occurrence of the evidence URL through the click redirect
 * (§8.7): href="...", href='...' and bare text, in both bodies.
 */
export function rewriteEvidenceUrl(args: {
  html: string;
  text: string;
  evidenceUrl: string;
  clickUrl: string;
}): { html: string; text: string } {
  const { html, text, evidenceUrl, clickUrl } = args;
  if (!evidenceUrl) return { html, text };

  const plain = new RegExp(escapeRegExp(evidenceUrl), 'g');
  // A generator that html escaped the ampersands in a query string still has
  // to be rewritten, so match that form too.
  const escaped = evidenceUrl.replace(/&/g, '&amp;');
  const escapedPattern = escaped === evidenceUrl ? null : new RegExp(escapeRegExp(escaped), 'g');

  let nextHtml = html.replace(plain, clickUrl);
  if (escapedPattern) nextHtml = nextHtml.replace(escapedPattern, clickUrl);

  const nextText = text.replace(plain, clickUrl);

  return { html: nextHtml, text: nextText };
}

/** `${base}/u/${token}` */
export function unsubscribeUrl(base: string, token: string): string {
  return `${stripTrailingSlash(base)}/u/${token}`;
}

/** `${base}/c/${token}` */
export function clickUrl(base: string, token: string): string {
  return `${stripTrailingSlash(base)}/c/${token}`;
}

/** `${base}/data` */
export function dataNoticeUrl(base: string): string {
  return `${stripTrailingSlash(base)}/data`;
}
