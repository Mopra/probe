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
 * Addresses on hosts we never contact, plus the placeholder addresses that a
 * landing-page scrape produces on almost every run.
 */
export function isDisposableOrJunk(emailNorm: string): boolean {
  const at = emailNorm.indexOf('@');
  if (at <= 0) return true;
  const local = emailNorm.slice(0, at);
  const domain = emailNorm.slice(at + 1);

  if (JUNK_DOMAINS.has(domain)) return true;
  for (const suffix of JUNK_SUFFIXES) {
    if (domain.endsWith(suffix)) return true;
  }
  // A Sentry DSN key is a long hex blob. Catch the shape as well as the host,
  // since Sentry self-hosted installs use arbitrary domains.
  if (/^[0-9a-f]{16,}$/.test(local)) return true;
  if (PLACEHOLDER_LOCALS.has(local)) return true;

  return false;
}
