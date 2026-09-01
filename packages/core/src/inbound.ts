// PLAN.md 5.3. An out-of-office must not burn a contact or inflate the one
// metric that matters, so this filter runs before anything else in the inbound
// handler.

export type Headers = Record<string, string | string[] | undefined>;

/** Header names are case insensitive and a value may arrive as an array. */
function header(headers: Headers, name: string): string | null {
  if (!headers || typeof headers !== 'object') return null;
  const wanted = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() !== wanted) continue;
    const value = headers[key];
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      const first = value.find((v) => typeof v === 'string' && v.trim().length > 0);
      if (first !== undefined) return first.trim();
      continue;
    }
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return null;
}

function has(headers: Headers, name: string): boolean {
  if (!headers || typeof headers !== 'object') return false;
  const wanted = name.toLowerCase();
  return Object.keys(headers).some(
    (key) => key.toLowerCase() === wanted && headers[key] !== undefined && headers[key] !== null,
  );
}

const PRECEDENCE_AUTOMATED = new Set(['bulk', 'auto_reply', 'auto-reply', 'junk', 'list']);

const AUTORESPONDER_HEADERS = [
  'x-autoresponse',
  'x-autoreply',
  'x-autorespond',
  'x-auto-response-suppress',
];

// Last resort only. Subject lines are recipient authored and a human can write
// any of these on purpose, so nothing here fires unless the headers were
// silent.
const AUTOMATED_SUBJECTS: RegExp[] = [
  /^\s*(?:re\s*:\s*|fwd?\s*:\s*)*(?:automatic reply|auto(?:matic)?[- ]?response|auto[- ]?reply)\b/i,
  /^\s*(?:re\s*:\s*|fwd?\s*:\s*)*out of (?:the )?office\b/i,
  /\bout of office\b/i,
  /\bautomatisk svar\b/i,
  /\babwesenheits?notiz\b/i,
  /\baus dem b[uü]ro\b/i,
  /^\s*undelivered mail returned to sender\b/i,
  /^\s*delivery status notification\b/i,
  /^\s*mail delivery (?:failed|subsystem)\b/i,
  /^\s*returned mail\b/i,
  /^\s*failure notice\b/i,
];

/**
 * True when the message is machine generated: an Auto-Submitted header with
 * any value other than 'no', a bulk or auto-reply Precedence, any of the
 * autoresponder headers, a null return path, a bounce-shaped From, or, only if
 * all of that was silent, an out-of-office shaped Subject.
 *
 * Automated mail is forwarded but never suppresses and never counts as a
 * reply (5.3).
 */
export function isAutomatedMessage(headers: Headers): boolean {
  const autoSubmitted = header(headers, 'auto-submitted');
  if (autoSubmitted !== null) {
    // 'auto-submitted: auto-replied; owner=...' carries parameters after a
    // semicolon. Only the value itself matters.
    const value = (autoSubmitted.split(';')[0] ?? '').trim().toLowerCase();
    if (value.length > 0 && value !== 'no') return true;
  }

  const precedence = header(headers, 'precedence');
  if (precedence !== null && PRECEDENCE_AUTOMATED.has(precedence.trim().toLowerCase())) {
    return true;
  }

  for (const name of AUTORESPONDER_HEADERS) {
    if (has(headers, name)) return true;
  }

  // An empty Return-Path is the SMTP null sender, which every bounce uses so
  // that a bounce of a bounce cannot loop.
  const returnPath = header(headers, 'return-path');
  if (returnPath !== null && (returnPath === '<>' || returnPath === '')) return true;

  const from = parseFromAddress(header(headers, 'from') ?? undefined);
  if (from !== null) {
    const local = from.slice(0, from.indexOf('@'));
    if (local === 'mailer-daemon' || local === 'postmaster') return true;
  }

  const subject = header(headers, 'subject');
  if (subject !== null) {
    for (const pattern of AUTOMATED_SUBJECTS) {
      if (pattern.test(subject)) return true;
    }
  }

  return false;
}

const ADDRESS = /[^\s<>()[\],;:"@]+@[^\s<>()[\],;:"@]+\.[^\s<>()[\],;:"@]+/;

/**
 * Pulls the first plausible address out of a From header value, handling both
 * 'Name <addr@host>' and a bare address. Lowercased, but not otherwise
 * normalized: +tag stripping belongs to normalizeEmail, which the caller runs
 * next.
 */
export function parseFromAddress(from: string | undefined): string | null {
  if (typeof from !== 'string') return null;
  const raw = from.trim();
  if (raw.length === 0) return null;

  // Angle brackets win: a quoted display name may itself contain an address.
  const angled = raw.match(/<([^<>]*)>/);
  if (angled) {
    const inner = (angled[1] ?? '').trim();
    const hit = inner.match(ADDRESS);
    if (hit) return trimAddress(hit[0]);
    // '<>' is the null sender, not an address.
    return null;
  }

  const hit = raw.match(ADDRESS);
  return hit ? trimAddress(hit[0]) : null;
}

function trimAddress(address: string): string {
  let a = address.trim().toLowerCase();
  while (a.endsWith('.') || a.endsWith(',')) a = a.slice(0, -1);
  const at = a.indexOf('@');
  if (at <= 0 || at === a.length - 1) return a;
  return a;
}
