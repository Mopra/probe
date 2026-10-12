import { createHmac } from 'node:crypto';

// Characters that never appear in a plain address we would ever mail. If a
// scrape hands us one of these we would rather drop the candidate than guess.
const ILLEGAL_LOCAL = /[^a-z0-9!#$%&'*+/=?^_`{|}~.-]/;
const DOMAIN_LABEL = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

/**
 * Lowercase, trim, strip a surrounding angle-bracket pair, strip a +tag from
 * the local part, validate the shape. Returns null for anything that is not a
 * plausible single address. Never throws: callers feed this raw scrape output.
 */
export function normalizeEmail(raw: string): string | null {
  if (typeof raw !== 'string') return null;
  let s = raw.trim();
  if (s.length === 0) return null;

  // 'Name <a@b.com>' is handled by parseFromAddress in inbound.ts. Here we only
  // peel a bare '<a@b.com>'.
  if (s.startsWith('<') && s.endsWith('>')) s = s.slice(1, -1).trim();

  if (s.toLowerCase().startsWith('mailto:')) s = s.slice(7).trim();

  // A mailto: often carries '?subject=...'. Anything after the query is not
  // part of the address.
  const q = s.indexOf('?');
  if (q !== -1) s = s.slice(0, q).trim();

  s = s.toLowerCase();

  if (s.length === 0 || s.length > 254) return null;
  if (/\s/.test(s)) return null;
  if (s.includes('<') || s.includes('>') || s.includes(',') || s.includes(';')) return null;

  const at = s.split('@');
  if (at.length !== 2) return null;
  let [local, domain] = at as [string, string];

  // Strip the +tag. 'morten+hn@exit1.dev' and 'morten@exit1.dev' are one human,
  // and the contact-once policy (§3.2) only works if they hash the same.
  const plus = local.indexOf('+');
  if (plus !== -1) local = local.slice(0, plus);

  if (local.length === 0 || local.length > 64) return null;
  if (ILLEGAL_LOCAL.test(local)) return null;
  if (local.startsWith('.') || local.endsWith('.') || local.includes('..')) return null;

  if (domain.endsWith('.')) return null;
  if (domain.startsWith('.') || domain.includes('..')) return null;

  const labels = domain.split('.');
  // A domain with no dot is either 'localhost' or a scrape artefact. Neither is
  // mailable.
  if (labels.length < 2) return null;
  for (const label of labels) {
    if (label.length === 0 || label.length > 63) return null;
    if (!DOMAIN_LABEL.test(label)) return null;
  }
  const tld = labels[labels.length - 1] as string;
  if (tld.length < 2 || /[0-9]/.test(tld)) return null;

  return `${local}@${domain}`;
}

/**
 * HMAC-SHA256(pepper, emailNorm) as lowercase hex, never a bare sha256 (§9.3).
 * An unsalted hash of an email address is dictionary-reversible, which would
 * make the hash-only claim on `suppressions` decorative.
 */
export function hashEmail(emailNorm: string, pepper: string): string {
  if (!pepper) throw new Error('hashEmail: pepper is required');
  return createHmac('sha256', pepper).update(emailNorm, 'utf8').digest('hex');
}

const ROLE_LOCALS = new Set([
  'info',
  'support',
  'sales',
  'admin',
  'administrator',
  'noreply',
  'no-reply',
  'donotreply',
  'do-not-reply',
  'postmaster',
  'webmaster',
  'hostmaster',
  'abuse',
  'billing',
  'accounts',
  'accounting',
  'help',
  'helpdesk',
  'marketing',
  'press',
  'media',
  'careers',
  'jobs',
  'hr',
  'legal',
  'privacy',
  'security',
  'newsletter',
  'notifications',
  'mailer-daemon',
]);

/**
 * Role addresses we refuse to treat as a founder contact. The email is written
 * as one person to another person, and a shared inbox breaks that premise.
 *
 * 'hello@' is deliberately NOT a role address. On a solo founder launch it is
 * overwhelmingly the founder's own inbox, often the only address on the site,
 * so treating it as a role address would throw away the single most common
 * real contact we find. Same reasoning for 'contact@' and 'team@': kept
 * contactable rather than discarded.
 */
export function isRoleAddress(emailNorm: string): boolean {
  const at = emailNorm.indexOf('@');
  if (at <= 0) return false;
  return ROLE_LOCALS.has(emailNorm.slice(0, at));
}

const JUNK_DOMAINS = new Set([
  'example.com',
  'example.org',
  'example.net',
  'example.edu',
  'example',
  'localhost',
  'localhost.localdomain',
  'test.com',
  'domain.com',
  'yourdomain.com',
  'yoursite.com',
  'youremail.com',
  'email.com',
  'mydomain.com',
  'company.com',
  'wixpress.com',
  'sentry.io',
  'sentry-cdn.com',
  'mailinator.com',
  'yopmail.com',
  'guerrillamail.com',
  '10minutemail.com',
  'tempmail.com',
  'temp-mail.org',
  'trashmail.com',
  'throwawaymail.com',
  'getnada.com',
  'maildrop.cc',
  'dispostable.com',
  'sharklasers.com',
]);

const JUNK_SUFFIXES = [
  '.example.com',
  '.example',
  '.local',
  '.localhost',
  '.invalid',
  '.test',
  // Sentry DSNs embed a public key as the local part of what looks like an
  // address, e.g. 'abc123@o42.ingest.sentry.io'. A scrape of a bundled JS file
  // finds these constantly and none of them are humans.
  '.sentry.io',
  '.wixpress.com',
  '.ingest.sentry.io',
];

const PLACEHOLDER_LOCALS = new Set([
  'you',
  'your',
  'youremail',
  'your-email',
  'yourname',
  'your-name',
  'email',
  'e-mail',
  'name',
  'username',
  'user',
  'someone',
  'somebody',
  'test',
  'testing',
  'tester',
  'example',
  'foo',
  'bar',
  'baz',
  'qux',
  'lorem',
  'ipsum',
  'placeholder',
  'sample',
  'demo',
  'dummy',
  'johndoe',
  'john.doe',
  'janedoe',
  'jane.doe',
  'firstname',
  'lastname',
  'first.last',
  'sentry',
]);

/**
 * Role words that disqualify an address wherever they sit in the local part,
 * not only when they are the whole of it. The bounce that taught us this was
 * 'helpfaqsupport@', which an exact match on 'support' waves through. Matched
 * against the local part with separators removed, so 'no-reply', 'no.reply' and
 * 'noreply' are one word.
 *
 * Every entry is long and specific enough that it does not occur inside a
 * plausible given name or surname. Short words that do ('hr' in 'shreya', 'info'
 * in a handle, 'help' in 'whelpley') live in ROLE_TOKENS instead.
 */
const ROLE_SUBSTRINGS = [
  'support',
  'noreply',
  'donotreply',
  'partner',
  'billing',
  'invoice',
  'abuse',
  'unsubscribe',
  'bounce',
  'mailer',
  'notification',
  'alerts',
  'newsletter',
  'privacy',
  'security',
  'webmaster',
  'postmaster',
  'hostmaster',
  'helpdesk',
  'careers',
];

/**
 * Short role words, matched only as a whole token between separators
 * ('jobs.team@', 'faq-help@') or, for 'help', as the start of the local part
 * ('helpteam@'). A substring match here would reject real names.
 */
const ROLE_TOKENS = new Set(['help', 'faq', 'jobs', 'legal', 'hr']);
const ROLE_PREFIXES = ['help'];

/**
 * Second level labels under which a three label domain is still somebody's
 * registered domain rather than a subdomain: 'acme.co.uk', 'shop.com.au'. Only
 * honoured above a two letter country code, because 'co.example.com' is a
 * subdomain whatever its middle label says.
 */
const SECOND_LEVEL_LABELS = new Set(['co', 'com', 'org', 'net', 'ac', 'gov', 'edu', 'ltd', 'plc', 'me']);

const VOWELS = /[aeiouy]/;

/**
 * Why a local part looks generated rather than chosen by a person, or null.
 *
 * The bounces this was written against were a hex token
 * ('562ae1d6@ssh.ephemerals.dev') and the shapes around it. A person picks a
 * name, an initial or a word; a machine picks a blob. None of these rules can
 * prove an address exists, which is the LLM screen's half of the job. They only
 * catch what is cheap and certain.
 */
function randomLocalReason(local: string): string | null {
  // Very long locals are tracking ids, encoded tokens or reply-to routing
  // addresses. A human's own address is almost never this long.
  if (local.length > 30) return 'local part is too long to be chosen by a person';

  // All digits, or mostly digits once there are enough of them to be an id
  // rather than a birth year. 'jd1990' passes; '84720193' and 'u2938471' do not.
  const alnum = local.replace(/[^a-z0-9]/g, '');
  const digits = local.replace(/[^0-9]/g, '').length;
  if (alnum.length > 0 && digits === alnum.length) return 'local part is all digits';
  if (digits >= 5 && digits * 2 >= alnum.length) return 'local part is mostly digits';

  // A Sentry DSN key is a long hex blob, and Sentry self-hosted installs use
  // arbitrary domains, so the shape is caught as well as the host. Eight or
  // more hex characters with a digit in them is the same thing, shorter: a
  // hash prefix or an ephemeral mailbox id. The digit matters, since 'deadbeef'
  // and 'facade' are words.
  if (/^[0-9a-f]{16,}$/.test(local)) return 'local part is a hex token';
  if (/^[0-9a-f]{8,}$/.test(local) && /[0-9]/.test(local)) return 'local part is a hex token';

  // Six consonants in a row does not happen in a name, in any language we are
  // likely to mail ('tschmidt' peaks at five). 'y' counts as a vowel because
  // it acts as one in 'lynn' and 'glyn'. A run of letters with no vowel at all
  // is the same signal on a shorter string; initials stay under five letters.
  if (/[b-df-hj-np-tv-xz]{6,}/.test(local)) return 'local part has no vowels for too long';
  for (const token of local.split(/[._-]+/)) {
    const letters = token.replace(/[^a-z]/g, '');
    if (letters.length >= 5 && !VOWELS.test(letters)) return 'local part has no vowels';
  }

  return null;
}

/** The role word inside the local part, or null. See ROLE_SUBSTRINGS. */
function roleWordIn(local: string): string | null {
  const joined = local.replace(/[._-]+/g, '');
  for (const word of ROLE_SUBSTRINGS) {
    if (joined.includes(word)) return word;
  }
  for (const token of local.split(/[._-]+/)) {
    if (ROLE_TOKENS.has(token)) return token;
  }
  for (const prefix of ROLE_PREFIXES) {
    if (local.startsWith(prefix) && local !== prefix) return prefix;
  }
  return null;
}

/**
 * True when the domain is a subdomain of a registered domain. Founders get
 * their mail on the domain they bought; 'ssh.ephemerals.dev' and
 * 'o42.ingest.example.io' are infrastructure, and a scrape that finds an
 * address there has found a config value, not an inbox.
 */
function isSubdomain(domain: string): boolean {
  const labels = domain.split('.');
  if (labels.length <= 2) return false;
  if (labels.length === 3) {
    const tld = labels[2] as string;
    const second = labels[1] as string;
    if (tld.length === 2 && SECOND_LEVEL_LABELS.has(second)) return false;
  }
  return true;
}

/**
 * Every deterministic reason to refuse an address before anyone is asked
 * about it, as a short phrase for the log and the contact row, or null when
 * the address passes.
 *
 * Pure and cheap on purpose: it runs at extraction time on every candidate a
 * scrape produces, so the contact cascade falls through to its next step
 * rather than settling on junk, and it runs again before the LLM screen so a
 * rule change applies to contacts found under the old rules.
 *
 * 'hello@', 'contact@' and 'team@' pass, for the reasons on isRoleAddress.
 */
export function junkReason(emailNorm: string): string | null {
  const at = emailNorm.indexOf('@');
  if (at <= 0) return 'not an address';
  const local = emailNorm.slice(0, at);
  const domain = emailNorm.slice(at + 1);

  if (JUNK_DOMAINS.has(domain)) return 'placeholder or disposable domain';
  for (const suffix of JUNK_SUFFIXES) {
    if (domain.endsWith(suffix)) return 'placeholder or disposable domain';
  }
  if (PLACEHOLDER_LOCALS.has(local)) return 'placeholder local part';

  const random = randomLocalReason(local);
  if (random) return random;

  const role = roleWordIn(local);
  if (role) return `role word in local part (${role})`;

  if (isSubdomain(domain)) return 'address on a subdomain';

  return null;
}

/**
 * Addresses on hosts we never contact, the placeholder addresses that a
 * landing-page scrape produces on almost every run, and everything else
 * junkReason refuses.
 */
export function isDisposableOrJunk(emailNorm: string): boolean {
  return junkReason(emailNorm) !== null;
}
