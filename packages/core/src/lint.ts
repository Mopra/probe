/**
 * The copy lint (§9.2.8).
 *
 * Mechanical enforcement of the entire content policy. It runs in the dry-run
 * harness and again at approval (§8.5); a failure blocks the queue. Generators
 * are code, and code drifts: this is what keeps a future generator tweak from
 * quietly turning informative into salesy.
 *
 * Pure. No IO, no imports, no clock.
 */

export interface LintInput {
  subject: string;
  html: string;
  text: string;
  productName: string; // 'exit1.dev'
  productDomain: string; // 'exit1.dev'
  evidenceUrl: string; // post rewrite click URL, or the raw evidence url
  unsubscribeUrl: string;
  dataNoticeUrl: string;
  postalAddress: string;
  fromName: string;
  fromEmail: string;
  /**
   * The RECIPIENT's own domain, e.g. 'meterbase.dev'. A url on their own site
   * is allowed in the body on top of the three permitted links (§9.2.5).
   *
   * This is not a loophole in the three-link rule, it is what the rule was
   * always about. §9.2.5 forbids a fourth link because a fourth link is a
   * funnel: somewhere WE want the reader to go. A url pointing at the
   * recipient's own broken page is the opposite of a funnel. It is the evidence,
   * and it is what makes "verify it in thirty seconds" (§1) literally true:
   * "your landing page links to https://theirsite.dev/status, which returned
   * 404" can be clicked and confirmed, where "/status 404s" has to be
   * reconstructed.
   *
   * Optional. When absent, only the three permitted links are allowed, which is
   * the stricter reading and the right default for a caller that does not know
   * whose email it is composing.
   */
  recipientDomain?: string | null;
}

export type LintCode =
  | 'forbidden_phrase'
  | 'product_mention_count'
  | 'missing_footer_element'
  | 'link_not_permitted'
  | 'missing_permitted_link'
  | 'missing_contact_once'
  | 'missing_provenance'
  | 'empty_subject'
  | 'subject_too_long'
  | 'closing_question'
  | 'html_text_divergence'
  | 'tracking_pixel'
  | 'placeholder_postal_address';

export interface LintViolation {
  code: LintCode;
  message: string;
  where: 'subject' | 'html' | 'text' | 'both';
}

export interface LintResult {
  ok: boolean;
  violations: LintViolation[];
}

export const SUBJECT_MAX_LENGTH = 120;

/** Below this Jaccard similarity the two body variants are not telling the
 *  same story, and one of them is carrying something the other is not. */
export const HTML_TEXT_MIN_SIMILARITY = 0.5;

/**
 * Forbidden vocabulary (§9.2.5, §9.2.8).
 *
 * Two registers of pattern live here.
 *
 * Broad: phrases that only ever appear in a pitch. "free trial", "book a call",
 * "limited time" and friends have no business in a finding about someone
 * else's product, so a bare word boundary match is correct and a false
 * positive costs one operator glance.
 *
 * Deliberately narrow: "sign up", "signup", "pricing", "demo", "upgrade" and
 * "subscribe" are all words a truthful finding may need, because the finding
 * is about THEIR surface. "Your signup flow returns a 500" and "your /pricing
 * page 404s" are exactly the emails probe exists to send, and "upgrade to TLS
 * 1.3" is a fix, not an offer. Those patterns therefore require the word to
 * appear as an imperative or an offer ("sign up for", "our pricing", "book a
 * demo", "upgrade to pro"), never as a noun describing the recipient's own
 * product. Word boundaries also keep the footer's "unsubscribe" from tripping
 * the "subscribe" pattern.
 */
export const FORBIDDEN_PATTERNS: { pattern: RegExp; label: string }[] = [
  // Narrow: offer or imperative forms only.
  { pattern: /\bsign[\s-]?up\s+(?:for|at|here|today|free|now|and)\b/i, label: 'sign up (offer)' },
  {
    pattern: /(?:^|[.!?]\s+)sign[\s-]?up\b(?!\s+(?:flow|form|page|endpoint|screen|link|error|route))/im,
    label: 'sign up (imperative)',
  },
  { pattern: /\b(?:our|my|the)\s+pricing\b/i, label: 'pricing (offer)' },
  { pattern: /\bpricing\s+(?:starts|is|below|here)\b/i, label: 'pricing (offer)' },
  { pattern: /\bplans\s+start\s+at\b/i, label: 'plans start at' },
  {
    pattern: /\$\s?\d[\d.,]*\s*(?:\/|per\s+)?(?:mo\b|month\b|year\b|yr\b|user\b|seat\b)/i,
    label: 'price figure',
  },
  { pattern: /\b(?:book|schedule|set\s+up|get|want|grab)\s+a\s+demo\b/i, label: 'demo (offer)' },
  { pattern: /\bdemo\s+(?:call|link|account)\b/i, label: 'demo (offer)' },
  { pattern: /\bupgrade\s+(?:to\s+)?(?:pro\b|premium\b|paid\b|a\s+paid\b|your\s+plan\b|now\b)/i, label: 'upgrade (offer)' },
  { pattern: /\bsubscribe\s+(?:to|here|now|for)\b/i, label: 'subscribe (offer)' },

  // Broad: pitch vocabulary with no innocent reading in this context.
  { pattern: /\bfree\s+trial\b/i, label: 'free trial' },
  { pattern: /\bstart\s+your\s+trial\b/i, label: 'start your trial' },
  { pattern: /\bbook\s+a\s+call\b/i, label: 'book a call' },
  { pattern: /\b(?:jump|hop|get)\s+on\s+a\s+(?:quick\s+)?call\b/i, label: 'jump on a call' },
  { pattern: /\blet\s+me\s+know\s+if\b/i, label: 'let me know if' },
  { pattern: /\bhappy\s+to\b/i, label: 'happy to' },
  { pattern: /\bdiscount(?:s|ed|ing)?\b/i, label: 'discount' },
  { pattern: /\b\d+\s?%\s?off\b/i, label: 'percent off' },
  { pattern: /\blimited\s+time\b/i, label: 'limited time' },
  { pattern: /\bact\s+now\b/i, label: 'act now' },
  { pattern: /\bdon['’]?t\s+miss\b/i, label: 'do not miss' },
  { pattern: /\bexclusive\s+offer\b/i, label: 'exclusive offer' },
  { pattern: /\bget\s+started\s+today\b/i, label: 'get started today' },
];

/** §9.2.6. The one email policy has to be visible in the body, not only in the
 *  footer probe controls. */
const CONTACT_ONCE_PATTERNS: RegExp[] = [
  /\bonly\s+email\s+(?:you|you['’]?ll|i['’]?ll)[^.]{0,40}\bever\b/i,
  /\bthis\s+is\s+the\s+only\s+email\b/i,
  /\bno\s+follow[\s-]?ups?\b/i,
  /\bno\s+sequence\b/i,
  /\bone\s+email,?\s+ever\b/i,
  /\byou\s+(?:will|wo)n?['’]?t\s+hear\s+from\s+me\s+again\b/i,
];

/** §9.2.4, first half: who is writing, and what they run. */
const RUNS_PRODUCT_PATTERN = /\bi\s+(?:run|built|build|make|made|maintain|own|wrote|work\s+on)\b/i;

/** §9.2.4, second half, which doubles as the GDPR Article 14 notice: where the
 *  address came from. */
const ADDRESS_SOURCE_PATTERNS: RegExp[] = [
  /\bfound\s+your\s+(?:email\s+|e-?mail\s+)?address\b/i,
  /\byour\s+address\s+(?:is|was)\s+(?:on|listed)\b/i,
  /\byour\s+\/?contact\s+page\b/i,
  /\byour\s+\/(?:contact|about|imprint|legal)\b/i,
  /\byour\s+hn\s+profile\b/i,
  /\byour\s+hacker\s+news\s+profile\b/i,
  /\bfrom\s+your\s+(?:site|website|landing\s+page|security\.txt|humans\.txt)\b/i,
  /\blisted\s+on\s+your\s+(?:site|website|landing\s+page|contact\s+page)\b/i,
];

const GREETING_ONLY_PATTERN =
  /^(?:hi|hey|hello|yo|greetings|dear|good\s+(?:morning|afternoon|evening)|congrats|congratulations)\b/i;

/** Words too common to carry meaning when comparing the two body variants. */
const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'for', 'from', 'has',
  'have', 'i', 'if', 'in', 'is', 'it', 'its', 'me', 'my', 'no', 'not', 'of',
  'on', 'or', 'so', 'that', 'the', 'their', 'them', 'then', 'there', 'they',
  'this', 'to', 'was', 'were', 'what', 'when', 'which', 'who', 'will', 'with',
  'you', 'your', 'yours',
]);

// ---------------------------------------------------------------------------
// html helpers
// ---------------------------------------------------------------------------

function decodeBasicEntities(input: string): string {
  return input
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&amp;/gi, '&');
}

/** Small, deliberate, dependency free. Strips script and style outright, turns
 *  block ends into newlines, decodes the five basic entities plus &nbsp;,
 *  drops the remaining tags and collapses whitespace. */
function htmlToText(html: string): string {
  let s = html.replace(/\r\n?/g, '\n');
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(
    /<\/(?:p|div|tr|li|h[1-6]|table|ul|ol|blockquote|section|article|header|footer|pre)\s*>/gi,
    '\n',
  );
  s = s.replace(/<[^>]*>/g, ' ');
  s = decodeBasicEntities(s);
  s = s
    .split('\n')
    .map((line) => line.replace(/[ \t ]+/g, ' ').trim())
    .join('\n');
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

function normalizeWhitespace(input: string): string {
  return input.replace(/\s+/g, ' ').trim();
}

function containsText(haystack: string, needle: string): boolean {
  if (!needle.trim()) return true;
  return normalizeWhitespace(haystack).toLowerCase().includes(normalizeWhitespace(needle).toLowerCase());
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// footer boundary
// ---------------------------------------------------------------------------

/**
 * Index at which the probe footer begins, or -1 when no footer marker is
 * present. renderFooter puts the postal address on the first footer line
 * exactly so this can be found without a sentinel: the earliest footer marker
 * wins, and the boundary is pulled back to the start of that line so the whole
 * footer is excluded from the body proper.
 */
function footerStart(text: string, input: LintInput): number {
  const markers = [input.postalAddress, input.unsubscribeUrl, input.dataNoticeUrl].filter(
    (m) => typeof m === 'string' && m.trim().length > 0,
  );
  let best = -1;
  for (const marker of markers) {
    const at = text.indexOf(marker);
    if (at >= 0 && (best < 0 || at < best)) best = at;
  }
  if (best < 0) return -1;
  const lineStart = text.lastIndexOf('\n', best);
  return lineStart < 0 ? 0 : lineStart;
}

function bodyProper(text: string, input: LintInput): string {
  const at = footerStart(text, input);
  return (at < 0 ? text : text.slice(0, at)).trim();
}

// ---------------------------------------------------------------------------
// link helpers
// ---------------------------------------------------------------------------

const BARE_URL_PATTERN = /https?:\/\/[^\s<>"'`)\]]+/gi;

function trimUrlPunctuation(url: string): string {
  return url.replace(/[.,;:!?)\]}>]+$/, '');
}

function canonicalUrl(url: string): string {
  const raw = trimUrlPunctuation(decodeBasicEntities(url.trim()));
  try {
    const parsed = new URL(raw);
    const path = parsed.pathname.replace(/\/+$/, '');
    return `${parsed.protocol}//${parsed.host}${path}${parsed.search}`.toLowerCase();
  } catch {
    return raw.toLowerCase().replace(/\/+$/, '');
  }
}

function hostOf(url: string): string | null {
  try {
    return new URL(trimUrlPunctuation(decodeBasicEntities(url.trim()))).host.toLowerCase();
  } catch {
    return null;
  }
}

function attributeOf(tag: string, name: string): string | null {
  const re = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s">]+))`, 'i');
  const m = re.exec(tag);
  if (!m) return null;
  return (m[1] ?? m[2] ?? m[3] ?? '').trim();
}

interface ExtractedLinks {
  urls: string[];
  mailtos: string[];
}

function extractHtmlLinks(html: string): ExtractedLinks {
  const urls: string[] = [];
  const mailtos: string[] = [];
  const hrefPattern = /href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s">]+))/gi;
  let m: RegExpExecArray | null = hrefPattern.exec(html);
  while (m !== null) {
    const raw = decodeBasicEntities((m[1] ?? m[2] ?? m[3] ?? '').trim());
    if (raw) {
      if (/^mailto:/i.test(raw)) mailtos.push(raw);
      else if (/^https?:/i.test(raw)) urls.push(trimUrlPunctuation(raw));
    }
    m = hrefPattern.exec(html);
  }
  const asText = htmlToText(html);
  for (const bare of asText.match(BARE_URL_PATTERN) ?? []) urls.push(trimUrlPunctuation(bare));
  for (const mailto of asText.match(/mailto:[^\s<>"')\]]+/gi) ?? []) mailtos.push(mailto);
  return { urls, mailtos };
}

function extractTextLinks(text: string): ExtractedLinks {
  const urls = (text.match(BARE_URL_PATTERN) ?? []).map(trimUrlPunctuation);
  const mailtos = text.match(/mailto:[^\s<>"')\]]+/gi) ?? [];
  return { urls, mailtos };
}

function mailtoAddress(value: string): string {
  return value
    .replace(/^mailto:/i, '')
    .split('?')[0]
    .trim()
    .toLowerCase();
}

// ---------------------------------------------------------------------------
// similarity
// ---------------------------------------------------------------------------

function contentWords(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[^a-z0-9/._-]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOP_WORDS.has(w));
  return new Set(words);
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  return shared / (a.size + b.size - shared);
}

// ---------------------------------------------------------------------------
// counting
// ---------------------------------------------------------------------------

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  const matches = haystack.match(new RegExp(escapeRegExp(needle), 'gi'));
  return matches ? matches.length : 0;
}

/**
 * Counts productName and productDomain without double counting the one inside
 * the other ('exit1' inside 'exit1.dev').
 *
 * URLs are removed first. The evidence link is mandatory (§9.2.2) and it lives
 * on probe's own host, so counting the product domain inside a link would make
 * the rule impossible to satisfy. A mention is prose naming the product; a
 * link that points somewhere it should not is caught by link_not_permitted.
 */
function countProductMentions(body: string, productName: string, productDomain: string): number {
  const needles = Array.from(new Set([productName, productDomain].map((n) => n.trim()).filter(Boolean))).sort(
    (a, b) => b.length - a.length,
  );
  let remaining = body.replace(/https?:\/\/\S+/gi, ' ').replace(/\bmailto:\S+/gi, ' ');
  let total = 0;
  for (const needle of needles) {
    const found = countOccurrences(remaining, needle);
    if (found === 0) continue;
    total += found;
    remaining = remaining.replace(new RegExp(escapeRegExp(needle), 'gi'), ' ');
  }
  return total;
}

function lastMeaningfulLine(body: string): string {
  const lines = body.split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (line.length > 0) return line;
  }
  return '';
}

// ---------------------------------------------------------------------------
// postal address
// ---------------------------------------------------------------------------

/**
 * Placeholder vocabulary that no real postal address contains.
 *
 * Deliberately phrases, not single words. 'street' and 'city' were here first
 * and had to come out: 'Oxford Street 5' and 'Cityringen 4' are real addresses,
 * and a rule that blocks the operator's own address is worse than no rule,
 * because the way out of it is to disable the rule. So each entry below is
 * something that appears in a template and never on an envelope.
 *
 * 'zip' and 'postcode' stay as bare words: an address carries a postcode, it
 * never spells the word.
 */
const POSTAL_PLACEHOLDER_PHRASES = [
  'your street',
  'street name',
  'your city',
  'city name',
  'your town',
  'your address',
  'address line',
  'your company',
  'company name',
  'your zip',
  'zip',
  'zipcode',
  'zip code',
  'postcode',
  'postal code',
  'todo',
  'fixme',
  'tbd',
  'xxx',
];

/**
 * Why the configured postal address is not a real one, or null when it looks
 * like an address. Pure and exported so the reason can be asserted directly.
 *
 * Three rules, each chosen to be almost impossible to trip on a real address
 * and impossible to pass with the committed placeholder:
 *
 *   1. No angle brackets. Every placeholder convention uses them, and no
 *      postal address does.
 *   2. At least one digit. Every deliverable address carries a street number
 *      or a postcode; a placeholder that spells out '<zip>' carries neither.
 *   3. No placeholder vocabulary. This catches the address whose brackets were
 *      stripped but whose words were not ('your street, 1234 your city'). It is
 *      matched on phrases rather than single words for a reason: see
 *      POSTAL_PLACEHOLDER_PHRASES.
 */
export function placeholderPostalAddress(postalAddress: string): string | null {
  const value = (postalAddress ?? '').trim();
  if (value.length === 0) {
    return 'No postal address is configured. CAN-SPAM (§9.2.7) requires one in every footer.';
  }

  if (/[<>]/.test(value)) {
    return (
      `The postal address "${value}" still contains a placeholder in angle brackets. ` +
      'Put a real physical address in probe.toml postal_address: CAN-SPAM (§9.2.7) requires ' +
      'one, and no email can be approved until it is there.'
    );
  }

  if (!/\d/.test(value)) {
    return (
      `The postal address "${value}" has no street number or postcode in it, so it is not ` +
      'an address a letter could be delivered to. CAN-SPAM (§9.2.7) requires a real one.'
    );
  }

  const folded = value.toLowerCase();
  for (const phrase of POSTAL_PLACEHOLDER_PHRASES) {
    // Whole word or phrase only, so 'Storegade', 'Kingsway' and 'Oxford Street'
    // are safe.
    const pattern = new RegExp(`(?:^|[^a-z0-9])${escapeRegExp(phrase)}(?:$|[^a-z0-9])`, 'i');
    if (pattern.test(folded)) {
      return (
        `The postal address "${value}" reads as a template: "${phrase}" is placeholder ` +
        'vocabulary, not part of a real address. CAN-SPAM (§9.2.7) requires a real one.'
      );
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// the lint
// ---------------------------------------------------------------------------

export function lintCopy(input: LintInput): LintResult {
  const violations: LintViolation[] = [];
  const add = (code: LintCode, where: LintViolation['where'], message: string): void => {
    violations.push({ code, where, message });
  };

  const htmlText = htmlToText(input.html);
  const htmlBody = bodyProper(htmlText, input);
  const textBody = bodyProper(input.text.replace(/\r\n?/g, '\n'), input);

  // --- subject (§9.2.1) ----------------------------------------------------
  const subject = input.subject.trim();
  if (subject.length === 0) {
    add('empty_subject', 'subject', 'Subject is empty. The finding itself is the subject line.');
  } else {
    const words = subject.split(/\s+/).filter(Boolean);
    if (GREETING_ONLY_PATTERN.test(subject) && words.length <= 6) {
      add(
        'empty_subject',
        'subject',
        `Subject "${subject}" is a greeting, not a finding. §9.2.1 wants the finding in the subject line.`,
      );
    }
  }
  if (subject.length > SUBJECT_MAX_LENGTH) {
    add('subject_too_long', 'subject', `Subject is ${subject.length} characters, maximum is ${SUBJECT_MAX_LENGTH}.`);
  }

  // --- forbidden vocabulary (§9.2.5) ---------------------------------------
  const scanTargets: Array<{ where: 'subject' | 'html' | 'text'; value: string }> = [
    { where: 'subject', value: input.subject },
    { where: 'html', value: htmlText },
    { where: 'text', value: input.text },
  ];
  for (const { pattern, label } of FORBIDDEN_PATTERNS) {
    for (const target of scanTargets) {
      if (pattern.test(target.value)) {
        add('forbidden_phrase', target.where, `Forbidden phrase "${label}" appears in the ${target.where}.`);
      }
    }
  }

  // --- zero asks: no closing question (§9.2.5) -----------------------------
  const closingWhere: Array<'html' | 'text'> = [];
  if (lastMeaningfulLine(textBody).endsWith('?')) closingWhere.push('text');
  if (lastMeaningfulLine(htmlBody).endsWith('?')) closingWhere.push('html');
  if (closingWhere.length > 0) {
    add(
      'closing_question',
      closingWhere.length === 2 ? 'both' : closingWhere[0],
      'The body closes on a question. §9.2.5 is zero asks: state the finding and stop.',
    );
  }

  // --- exactly one product mention in the body proper (§9.2.4) -------------
  const mentions = countProductMentions(textBody, input.productName, input.productDomain);
  if (mentions !== 1) {
    add(
      'product_mention_count',
      'text',
      mentions === 0
        ? `"${input.productName}" is never named in the body. §9.2.4 requires the provenance sentence that says who is writing.`
        : `"${input.productName}" appears ${mentions} times in the body, excluding the footer. Exactly one mention is allowed; more than one is a pitch.`,
    );
  }

  // --- provenance, doubling as the GDPR Article 14 notice (§9.2.4) ---------
  const sentences = textBody.split(/(?<=[.!?])\s+/);
  const runsProduct = sentences.some(
    (sentence) =>
      RUNS_PRODUCT_PATTERN.test(sentence) &&
      (containsText(sentence, input.productName) || containsText(sentence, input.productDomain)),
  );
  const addressSource = ADDRESS_SOURCE_PATTERNS.some((p) => p.test(textBody));
  if (!runsProduct || !addressSource) {
    const missing: string[] = [];
    if (!runsProduct) {
      missing.push(`a first person sentence naming ${input.productName} ("I run ${input.productName}")`);
    }
    if (!addressSource) {
      missing.push('a statement of where the address was found ("I found your address on your /contact page")');
    }
    add('missing_provenance', 'text', `Provenance block incomplete. Missing: ${missing.join('; ')}.`);
  }

  // --- contact once, stated in the body (§9.2.6) ---------------------------
  if (!CONTACT_ONCE_PATTERNS.some((p) => p.test(textBody))) {
    add(
      'missing_contact_once',
      'text',
      'The body never states the one email policy. §9.2.6: "This is the only email you will ever get from me. No follow-ups, no sequence."',
    );
  }

  // --- footer elements (§9.2.7) --------------------------------------------
  const footerElements: Array<{ label: string; value: string }> = [
    { label: 'postal address', value: input.postalAddress },
    { label: 'sender name', value: input.fromName },
    { label: 'unsubscribe link', value: input.unsubscribeUrl },
    { label: 'data notice link', value: input.dataNoticeUrl },
  ];
  for (const element of footerElements) {
    if (!element.value.trim()) continue;
    const inHtml = containsText(input.html, element.value) || containsText(htmlText, element.value);
    const inText = containsText(input.text, element.value);
    if (!inHtml || !inText) {
      add(
        'missing_footer_element',
        !inHtml && !inText ? 'both' : !inHtml ? 'html' : 'text',
        `Footer is missing the ${element.label} ("${element.value}").`,
      );
    }
  }

  // --- the postal address must be real (§9.2.7) ----------------------------
  // The footer check above only proves the configured string reached both
  // bodies, which a placeholder satisfies perfectly. CAN-SPAM wants an address
  // a letter could be delivered to, and the committed probe.toml ships
  // 'Pradsgaard Labs, <street>, <zip> <city>, Denmark' precisely so nobody
  // forgets to replace it. Without this rule that placeholder ships.
  const postalProblem = placeholderPostalAddress(input.postalAddress);
  if (postalProblem !== null) {
    add('placeholder_postal_address', 'both', postalProblem);
  }

  // --- exactly three permitted links (§9.2.5, §8.7) ------------------------
  const permitted = new Set<string>();
  for (const url of [input.evidenceUrl, input.unsubscribeUrl, input.dataNoticeUrl]) {
    if (url.trim()) permitted.add(canonicalUrl(url));
  }
  const permittedHosts = new Set(
    [input.evidenceUrl, input.unsubscribeUrl, input.dataNoticeUrl]
      .map(hostOf)
      .filter((h): h is string => h !== null),
  );

  // Hosts whose urls are allowed in the body without being one of the three.
  // Only the recipient's own domain, and its subdomains: a finding about
  // 'api.theirsite.dev' is still a finding about their surface.
  const recipientDomain = (input.recipientDomain ?? '').trim().toLowerCase().replace(/^www\./, '');
  const isRecipientUrl = (url: string): boolean => {
    if (recipientDomain.length === 0) return false;
    const host = hostOf(url);
    if (host === null) return false;
    const bare = host.replace(/^www\./, '').replace(/:\d+$/, '');
    return bare === recipientDomain || bare.endsWith(`.${recipientDomain}`);
  };

  const htmlLinks = extractHtmlLinks(input.html);
  const textLinks = extractTextLinks(input.text);
  const seenOffenders = new Set<string>();
  const checkLinks = (links: ExtractedLinks, where: 'html' | 'text'): void => {
    for (const url of links.urls) {
      const canon = canonicalUrl(url);
      if (permitted.has(canon)) continue;
      if (isRecipientUrl(url)) continue;
      const key = `${where}:${canon}`;
      if (seenOffenders.has(key)) continue;
      seenOffenders.add(key);
      add(
        'link_not_permitted',
        where,
        `Link "${url}" is not one of the three permitted links (evidence, unsubscribe, data notice).`,
      );
    }
    for (const mailto of links.mailtos) {
      const address = mailtoAddress(mailto);
      const isSender = address === input.fromEmail.trim().toLowerCase();
      const isUnsubscribe = /^unsubscribe/i.test(address) || /unsubscribe/i.test(mailto.split('?')[1] ?? '');
      if (isSender || isUnsubscribe) continue;
      const key = `${where}:mailto:${address}`;
      if (seenOffenders.has(key)) continue;
      seenOffenders.add(key);
      add(
        'link_not_permitted',
        where,
        `mailto link "${address}" points at neither ${input.fromEmail} nor a List-Unsubscribe mailbox.`,
      );
    }
  };
  checkLinks(htmlLinks, 'html');
  checkLinks(textLinks, 'text');

  const htmlCanon = new Set(htmlLinks.urls.map(canonicalUrl));
  const textCanon = new Set(textLinks.urls.map(canonicalUrl));
  const required: Array<{ label: string; url: string }> = [
    { label: 'evidence link', url: input.evidenceUrl },
    { label: 'unsubscribe link', url: input.unsubscribeUrl },
    { label: 'data notice link', url: input.dataNoticeUrl },
  ];
  for (const item of required) {
    if (!item.url.trim()) {
      add('missing_permitted_link', 'both', `No ${item.label} was supplied.`);
      continue;
    }
    const canon = canonicalUrl(item.url);
    const inHtml = htmlCanon.has(canon);
    const inText = textCanon.has(canon);
    if (!inHtml || !inText) {
      const side = !inHtml && !inText ? 'html and text' : !inHtml ? 'html' : 'text';
      add(
        'missing_permitted_link',
        !inHtml && !inText ? 'both' : !inHtml ? 'html' : 'text',
        `The ${item.label} (${item.url}) is missing from the ${side} body.`,
      );
    }
  }

  // --- no open tracking (§8.7) ---------------------------------------------
  for (const tag of input.html.match(/<img\b[^>]*>/gi) ?? []) {
    const width = attributeOf(tag, 'width');
    const height = attributeOf(tag, 'height');
    const style = attributeOf(tag, 'style') ?? '';
    const src = attributeOf(tag, 'src') ?? '';
    if (width === '1' || height === '1' || /(?:width|height)\s*:\s*1(?:px)?\b/i.test(style)) {
      add('tracking_pixel', 'html', `A one pixel image is a tracking pixel: ${src || tag}. §8.7 forbids open tracking.`);
      continue;
    }
    if (/^https?:/i.test(src)) {
      const host = hostOf(src);
      if (host !== null && !permittedHosts.has(host)) {
        add(
          'tracking_pixel',
          'html',
          `Image "${src}" loads from ${host}, which is not one of the permitted hosts. A remote image is open tracking by another name.`,
        );
      }
    }
  }

  // --- the two variants must tell the same story ---------------------------
  const similarity = jaccard(contentWords(htmlBody), contentWords(textBody));
  if (similarity < HTML_TEXT_MIN_SIMILARITY) {
    add(
      'html_text_divergence',
      'both',
      `The html and text bodies share only ${(similarity * 100).toFixed(0)}% of their content words (minimum ${(
        HTML_TEXT_MIN_SIMILARITY * 100
      ).toFixed(0)}%). Both variants must carry the same finding.`,
    );
  }

  return { ok: violations.length === 0, violations };
}
