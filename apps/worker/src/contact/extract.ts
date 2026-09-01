// Address extraction (§8.3 step 1), pure and IO free so it can be tested
// against fixture HTML without touching the network.
//
// Everything here is a heuristic over somebody else's markup. The bias is
// towards refusing an address rather than inventing one: a wrong address is a
// bounce against a brand new sending reputation (§5.5), and a missing one is
// just a lead dropped as no_contact.

import { load } from 'cheerio';
import { isDisposableOrJunk, isRoleAddress, normalizeEmail } from '@probe/core';

export type CandidateKind = 'mailto' | 'text' | 'obfuscated';

export interface EmailCandidate {
  /** The address as found, before normalisation. */
  email: string;
  kind: CandidateKind;
  /** Nearby text, used to mine a first name. */
  context: string;
}

export interface RankedCandidate extends EmailCandidate {
  emailNorm: string;
  ownDomain: boolean;
  confidence: number;
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,24}/g;

/** Hosts that belong to somebody other than the founder: platforms, CDNs,
 *  error collectors, the boilerplate of the modern landing page. An address
 *  here is never the person who launched the product. */
const THIRD_PARTY_HOSTS = [
  'sentry.io',
  'ingest.sentry.io',
  'wixpress.com',
  'wix.com',
  'wordpress.com',
  'wordpress.org',
  'automattic.com',
  'squarespace.com',
  'shopify.com',
  'godaddy.com',
  'namecheap.com',
  'cloudflare.com',
  'googleapis.com',
  'gstatic.com',
  'google-analytics.com',
  'googletagmanager.com',
  'fontawesome.com',
  'jsdelivr.net',
  'unpkg.com',
  'cdnjs.com',
  'bootstrapcdn.com',
  'typekit.net',
  'adobe.com',
  'w3.org',
  'schema.org',
  'mozilla.org',
  'jquery.com',
  'github.io',
  'githubusercontent.com',
  'vercel.com',
  'netlify.com',
  'netlify.app',
  'framer.com',
  'webflow.com',
  'carrd.co',
  'notion.so',
  'substack.com',
  'medium.com',
  'ghost.org',
  'mailchimp.com',
  'hubspot.com',
  'intercom.io',
  'zendesk.com',
  'stripe.com',
  'paddle.com',
  'facebook.com',
  'twitter.com',
  'linkedin.com',
  'youtube.com',
  'sentry-next.wixpress.com',
];

/** A text scrape picks up things like `logo@2x.png` and `hero@3x.webp`.
 *  They match the shape of an address and are never one. */
const ASSET_EXTENSIONS = [
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico', '.css', '.js',
  '.json', '.woff', '.woff2', '.ttf', '.otf', '.eot', '.mp4', '.webm', '.pdf',
];

/** Local parts that are a function, not a person. isRoleAddress covers the
 *  obvious ones; this list only decides whether the local part may be read as
 *  a first name, which is a lower bar and a different question. */
const NOT_A_NAME = new Set([
  'hello', 'hi', 'hey', 'howdy', 'yo', 'info', 'team', 'contact', 'support',
  'admin', 'mail', 'email', 'sales', 'help', 'press', 'jobs', 'careers',
  'founder', 'founders', 'me', 'us', 'we', 'office', 'hq', 'service',
  'services', 'enquiries', 'inquiries', 'general', 'noreply', 'no-reply',
  'feedback', 'ask', 'talk', 'dev', 'devs', 'developers', 'tech', 'security',
  'privacy', 'legal', 'abuse', 'billing', 'accounts', 'partners', 'media',
  'marketing', 'newsletter', 'news', 'welcome', 'hire', 'work', 'studio',
  'agency', 'app', 'api', 'web', 'root', 'postmaster', 'webmaster', 'owner',
]);

/** No `i` flag anywhere: the capture has to stay case sensitive, because a
 *  capitalised word is most of the evidence that it is a name at all. The
 *  lead-in words spell their own casing out instead. */
const NAME_PATTERNS: RegExp[] = [
  /\b[Ff]ounded by\s+([A-Z][a-z]{1,14})\b/,
  /\b[Bb]uilt by\s+([A-Z][a-z]{1,14})\b/,
  /\b[Mm]ade by\s+([A-Z][a-z]{1,14})\b/,
  /\b[Cc]reated by\s+([A-Z][a-z]{1,14})\b/,
  /\b([A-Z][a-z]{1,14})(?:\s+[A-Z][a-z]+)?\s*,\s*(?:the\s+)?(?:[Cc]o[- ]?)?[Ff]ounder\b/,
  /\b([A-Z][a-z]{1,14})(?:\s+[A-Z][a-z]+)?\s*[-|]\s*(?:[Cc]o[- ]?)?[Ff]ounder\b/,
  /\b(?:[Ii]'?m|[Ii] am)\s+([A-Z][a-z]{1,14})\b/,
  /\b(?:[Cc]ontact|[Ee]mail|[Rr]each out to|[Rr]each|[Ww]rite to|[Pp]ing)\s+([A-Z][a-z]{1,14})\b/,
];

export function domainOf(emailNorm: string): string {
  const at = emailNorm.lastIndexOf('@');
  return at === -1 ? '' : emailNorm.slice(at + 1).toLowerCase();
}

export function localPartOf(emailNorm: string): string {
  const at = emailNorm.lastIndexOf('@');
  return at === -1 ? emailNorm : emailNorm.slice(0, at);
}

/** True when the host is, or is a subdomain of, a third party we never treat
 *  as a founder contact. */
export function isThirdPartyAddress(emailNorm: string): boolean {
  const host = domainOf(emailNorm);
  if (!host) return true;
  return THIRD_PARTY_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

function looksLikeAsset(emailNorm: string): boolean {
  const host = domainOf(emailNorm);
  return ASSET_EXTENSIONS.some((ext) => host.endsWith(ext));
}

/** Every pure rejection rule in one place. Returns the normalised address, or
 *  null when we refuse it. The MX check is deliberately not here: it is IO,
 *  and it lives in mx.ts. */
export function acceptAddress(raw: string): string | null {
  const norm = normalizeEmail(raw);
  if (!norm) return null;
  if (looksLikeAsset(norm)) return null;
  if (isRoleAddress(norm)) return null;
  if (isDisposableOrJunk(norm)) return null;
  if (isThirdPartyAddress(norm)) return null;
  return norm;
}

/** Undoes the usual ways an address is hidden from a naive scraper: HTML
 *  entities, bracketed `[at]` and `[dot]`, and the spelled out form. The
 *  spelled out form is matched as a whole address rather than by replacing
 *  every ' at ' in the page, because doing the latter turns ordinary prose
 *  into plausible looking addresses. */
export function deobfuscate(input: string): string {
  let out = input;

  // Numeric and named HTML entities, for text that was never parsed as HTML.
  out = out.replace(/&#0*64;|&commat;|&#x0*40;/gi, '@');
  out = out.replace(/&#0*46;|&period;|&#x0*2e;/gi, '.');

  // Bracketed forms: unambiguous, safe to replace anywhere.
  out = out.replace(/\s*[[({<]\s*(?:at|@)\s*[\])}>]\s*/gi, '@');
  out = out.replace(/\s*[[({<]\s*(?:dot|punkt|\.)\s*[\])}>]\s*/gi, '.');

  // Spelled out, matched as a complete address so prose is left alone.
  out = out.replace(
    /\b([A-Za-z0-9._%+-]+)\s+(?:at|@)\s+([A-Za-z0-9-]+(?:\s*\.\s*[A-Za-z0-9-]+)*)\s+(?:dot|punkt)\s+([A-Za-z]{2,24})\b/gi,
    (_m, local: string, host: string, tld: string) => `${local}@${host.replace(/\s+/g, '')}.${tld}`,
  );

  // ' @ ' with padding, which survives most naive scrapers on its own.
  out = out.replace(/\s+@\s+/g, '@');

  return out;
}

function contextAround(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 120);
  const end = Math.min(text.length, index + length + 120);
  return text.slice(start, end).replace(/\s+/g, ' ').trim();
}

function matchesIn(text: string, kind: CandidateKind): EmailCandidate[] {
  const out: EmailCandidate[] = [];
  if (!text) return out;
  EMAIL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = EMAIL_RE.exec(text)) !== null) {
    out.push({ email: m[0], kind, context: contextAround(text, m.index, m[0].length) });
  }
  return out;
}

export function extractFromText(text: string): EmailCandidate[] {
  const plain = matchesIn(text, 'text');
  const seen = new Set(plain.map((c) => c.email.toLowerCase()));
  const hidden = matchesIn(deobfuscate(text), 'obfuscated').filter(
    (c) => !seen.has(c.email.toLowerCase()),
  );
  return [...plain, ...hidden];
}

function hrefToAddress(href: string): string | null {
  const value = href.trim();
  if (!/^mailto:/i.test(value)) return null;
  let rest = value.slice('mailto:'.length).split('?')[0] ?? '';
  try {
    rest = decodeURIComponent(rest);
  } catch {
    // A malformed percent escape is not worth failing the whole page over.
  }
  const first = rest.split(',')[0]?.trim() ?? '';
  return first || null;
}

/** mailto hrefs first, then the visible text, then the same text with the
 *  obfuscations undone. Script and style bodies are dropped before the text
 *  pass: a Sentry DSN looks exactly like an address. */
export function extractFromHtml(html: string): EmailCandidate[] {
  if (!html) return [];
  const out: EmailCandidate[] = [];
  let text = '';

  try {
    const $ = load(html);
    $('a[href]').each((_i, el) => {
      const address = hrefToAddress($(el).attr('href') ?? '');
      if (!address) return;
      const own = $(el).text().replace(/\s+/g, ' ').trim();
      const near = $(el).parent().text().replace(/\s+/g, ' ').trim().slice(0, 300);
      out.push({ email: address, kind: 'mailto', context: `${own} ${near}`.trim() });
    });
    $('script, style, noscript, svg').remove();
    // Block elements get a separator before the text is flattened, otherwise
    // an address in its own tag fuses with the word before it and no pattern
    // here can see either one.
    $('p, br, div, li, tr, td, h1, h2, h3, h4, h5, h6, section, article, footer, header').after(' ');
    text = $('body').text() || $.root().text();
  } catch {
    text = html;
  }

  const seen = new Set(out.map((c) => c.email.toLowerCase()));
  for (const candidate of extractFromText(text)) {
    if (seen.has(candidate.email.toLowerCase())) continue;
    seen.add(candidate.email.toLowerCase());
    out.push(candidate);
  }
  return out;
}

/** §8.3: 90 for a mailto on the lead's own domain, 70 for a mailto anywhere
 *  else, 50 for a plain text scrape, 40 for a deobfuscated one. */
export function confidenceFor(kind: CandidateKind, ownDomain: boolean): number {
  if (kind === 'mailto') return ownDomain ? 90 : 70;
  if (kind === 'text') return 50;
  return 40;
}

/** Accepted candidates, best first. An address on the lead's own domain wins
 *  over a higher confidence address somewhere else: the founder's own domain
 *  is the stronger signal that we have the right human, and confidence only
 *  describes how the string was found. */
export function rankCandidates(candidates: EmailCandidate[], leadDomain: string | null): RankedCandidate[] {
  const own = (leadDomain ?? '').toLowerCase().replace(/^www\./, '');
  const best = new Map<string, RankedCandidate>();

  for (const candidate of candidates) {
    const norm = acceptAddress(candidate.email);
    if (!norm) continue;
    const host = domainOf(norm);
    const ownDomain = Boolean(own) && (host === own || host.endsWith(`.${own}`) || own.endsWith(`.${host}`));
    const ranked: RankedCandidate = {
      ...candidate,
      emailNorm: norm,
      ownDomain,
      confidence: confidenceFor(candidate.kind, ownDomain),
    };
    const existing = best.get(norm);
    if (!existing || ranked.confidence > existing.confidence) best.set(norm, ranked);
  }

  return [...best.values()].sort((a, b) => {
    if (a.ownDomain !== b.ownDomain) return a.ownDomain ? -1 : 1;
    return b.confidence - a.confidence;
  });
}

function titleCase(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

/** A first name from the text around the address, or from the local part when
 *  that is clearly a given name rather than a function. Guessing wrong is not
 *  free: the name reaches the generator (§6) and can reach the recipient. */
export function firstNameFrom(contexts: string[], emailNorm: string | null): string | null {
  for (const context of contexts) {
    if (!context) continue;
    for (const pattern of NAME_PATTERNS) {
      const m = pattern.exec(context);
      const candidate = m?.[1];
      if (candidate && !NOT_A_NAME.has(candidate.toLowerCase())) return titleCase(candidate);
    }
  }

  if (!emailNorm) return null;
  const local = localPartOf(emailNorm);
  const first = local.split(/[._-]/)[0] ?? '';
  if (!/^[a-z]{3,14}$/i.test(first)) return null;
  if (NOT_A_NAME.has(first.toLowerCase())) return null;
  return titleCase(first);
}
