/**
 * RFC 5322 message assembly.
 *
 * The output is both what SES receives as raw content and what the dry-run
 * harness writes to ./outbox as a .eml file, so it has to open cleanly in a
 * real mail client. Hand rolled on purpose: @probe/core depends on zod and
 * node builtins only.
 */

import { randomBytes, randomUUID } from 'node:crypto';

export interface OutboundMessage {
  fromName: string;
  fromEmail: string;
  to: string;
  replyTo?: string;
  subject: string;
  html: string;
  text: string;
  unsubscribeUrl: string;
  unsubscribeMailto?: string;
  messageId?: string; // generated when absent
  date?: Date;
  headers?: Record<string, string>;
}

const CRLF = '\r\n';

/** Headers probe owns. An entry in `headers` can never override one of these,
 *  which is what keeps the List-Unsubscribe and From lines trustworthy. */
const RESERVED_HEADERS = new Set([
  'from',
  'to',
  'reply-to',
  'subject',
  'date',
  'message-id',
  'mime-version',
  'list-unsubscribe',
  'list-unsubscribe-post',
  'content-type',
  'content-transfer-encoding',
]);

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// ---------------------------------------------------------------------------
// header primitives
// ---------------------------------------------------------------------------

/** Header injection is impossible if no value can ever contain CR or LF. */
function sanitize(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim();
}

function isAscii(value: string): boolean {
  // eslint-disable-next-line no-control-regex
  return !/[^\x20-\x7E\t]/.test(value);
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** RFC 2822 date. Always rendered in UTC, which is unambiguous and keeps the
 *  output reproducible for the dry-run harness. */
function formatDate(date: Date): string {
  const day = DAY_NAMES[date.getUTCDay()];
  const month = MONTH_NAMES[date.getUTCMonth()];
  return (
    `${day}, ${pad2(date.getUTCDate())} ${month} ${date.getUTCFullYear()} ` +
    `${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())}:${pad2(date.getUTCSeconds())} +0000`
  );
}

/** RFC 2047 encoded words, base64, utf-8. Chunked on code point boundaries so
 *  no encoded word exceeds the 75 character limit and no multi byte character
 *  is split across two words. */
function encodeWords(value: string): string {
  const chunks: string[] = [];
  let current = '';
  let currentBytes = 0;
  for (const char of value) {
    const size = Buffer.byteLength(char, 'utf8');
    if (currentBytes + size > 45) {
      chunks.push(current);
      current = '';
      currentBytes = 0;
    }
    current += char;
    currentBytes += size;
  }
  if (current.length > 0) chunks.push(current);
  return chunks.map((chunk) => `=?utf-8?B?${Buffer.from(chunk, 'utf8').toString('base64')}?=`).join(`${CRLF} `);
}

/** Folds a long ASCII header at whitespace. Unbreakable runs are left alone:
 *  an over long single token is legal, a broken URL is not. */
function foldAscii(name: string, value: string): string {
  const limit = 78;
  const words = value.split(' ');
  let line = `${name}:`;
  const lines: string[] = [];
  for (const word of words) {
    if (line === `${name}:`) {
      line = `${line} ${word}`;
      continue;
    }
    if (line.length + 1 + word.length > limit) {
      lines.push(line);
      line = ` ${word}`;
    } else {
      line = `${line} ${word}`;
    }
  }
  lines.push(line);
  return lines.join(CRLF);
}

function header(name: string, rawValue: string): string {
  const value = sanitize(rawValue);
  if (isAscii(value)) return foldAscii(name, value);
  return `${name}: ${encodeWords(value)}`;
}

function quoteDisplayName(name: string): string {
  return `"${name.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function formatAddress(displayName: string, email: string): string {
  const address = sanitize(email).replace(/[<>]/g, '');
  const name = sanitize(displayName);
  if (!name) return address;
  return `${isAscii(name) ? quoteDisplayName(name) : encodeWords(name)} <${address}>`;
}

// ---------------------------------------------------------------------------
// quoted printable
// ---------------------------------------------------------------------------

function utf8SequenceLength(byte: number): number {
  if (byte >= 0xf0 && byte <= 0xf7) return 4;
  if (byte >= 0xe0 && byte <= 0xef) return 3;
  if (byte >= 0xc0 && byte <= 0xdf) return 2;
  return 1;
}

function escapeByte(byte: number): string {
  return `=${byte.toString(16).toUpperCase().padStart(2, '0')}`;
}

function literalByte(byte: number): boolean {
  if (byte === 0x3d) return false; // '='
  if (byte === 0x09) return true; // tab, unless trailing
  return byte >= 0x20 && byte <= 0x7e;
}

function encodeQpLine(line: string): string {
  const buf = Buffer.from(line, 'utf8');
  const tokens: string[] = [];

  for (let i = 0; i < buf.length; ) {
    const byte = buf[i];
    const seq = utf8SequenceLength(byte);
    if (seq > 1 && i + seq <= buf.length) {
      // Keep a multi byte character together so a soft line break can never
      // land in the middle of it.
      let token = '';
      for (let k = 0; k < seq; k += 1) token += escapeByte(buf[i + k]);
      tokens.push(token);
      i += seq;
      continue;
    }
    tokens.push(literalByte(byte) ? String.fromCharCode(byte) : escapeByte(byte));
    i += 1;
  }

  // Trailing whitespace has to be encoded or an intermediate MTA may eat it.
  for (let t = tokens.length - 1; t >= 0; t -= 1) {
    if (tokens[t] === ' ') tokens[t] = '=20';
    else if (tokens[t] === '\t') tokens[t] = '=09';
    else break;
  }

  const wrapped: string[] = [];
  let current = '';
  for (const token of tokens) {
    if (current.length + token.length > 75) {
      // Never leave whitespace immediately before a soft break: carry it to
      // the next line, where a leading space is harmless.
      let carry = '';
      while (current.length > 0 && (current.endsWith(' ') || current.endsWith('\t'))) {
        carry = current.slice(-1) + carry;
        current = current.slice(0, -1);
      }
      wrapped.push(`${current}=`);
      current = carry;
    }
    current += token;
  }
  wrapped.push(current);
  return wrapped.join(CRLF);
}

/** Quoted printable per RFC 2045: escapes '=', control bytes and everything
 *  above 0x7E, encodes trailing whitespace, soft wraps at 76 columns, and
 *  never splits an escape or a multi byte character across the wrap. */
function quotedPrintable(input: string): string {
  return input
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(encodeQpLine)
    .join(CRLF);
}

// ---------------------------------------------------------------------------
// the message
// ---------------------------------------------------------------------------

function makeBoundary(): string {
  return `----=_probe_${randomBytes(12).toString('hex')}`;
}

function makeMessageId(fromEmail: string): string {
  const domain = sanitize(fromEmail).split('@')[1] ?? 'probe.invalid';
  return `<${randomUUID()}@${domain}>`;
}

export function buildMime(msg: OutboundMessage): string {
  const boundary = makeBoundary();
  const date = msg.date ?? new Date();
  const rawMessageId = msg.messageId ? sanitize(msg.messageId) : makeMessageId(msg.fromEmail);
  const messageId = rawMessageId.startsWith('<') ? rawMessageId : `<${rawMessageId}>`;

  const lines: string[] = [];
  lines.push(header('From', formatAddress(msg.fromName, msg.fromEmail)));
  lines.push(header('To', sanitize(msg.to)));
  if (msg.replyTo && sanitize(msg.replyTo)) lines.push(header('Reply-To', sanitize(msg.replyTo)));
  lines.push(header('Subject', msg.subject));
  lines.push(`Date: ${formatDate(date)}`);
  lines.push(`Message-ID: ${messageId}`);
  lines.push('MIME-Version: 1.0');

  // RFC 8058 one click unsubscribe (§9.3).
  const unsubParts: string[] = [];
  const unsubHttp = sanitize(msg.unsubscribeUrl);
  if (unsubHttp) unsubParts.push(`<${unsubHttp}>`);
  if (msg.unsubscribeMailto && sanitize(msg.unsubscribeMailto)) {
    const mailto = sanitize(msg.unsubscribeMailto);
    unsubParts.push(`<${mailto.startsWith('mailto:') ? mailto : `mailto:${mailto}`}>`);
  }
  if (unsubParts.length > 0) {
    lines.push(`List-Unsubscribe: ${unsubParts.join(', ')}`);
    lines.push('List-Unsubscribe-Post: List-Unsubscribe=One-Click');
  }

  for (const [name, value] of Object.entries(msg.headers ?? {})) {
    const cleanName = sanitize(name).replace(/[^A-Za-z0-9-]/g, '');
    if (!cleanName || RESERVED_HEADERS.has(cleanName.toLowerCase())) continue;
    lines.push(header(cleanName, value));
  }

  // Folded so no header line runs past the 78 column recommendation.
  lines.push(`Content-Type: multipart/alternative;${CRLF} boundary="${boundary}"`);

  const body: string[] = [
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: quoted-printable',
    '',
    quotedPrintable(msg.text),
    `--${boundary}`,
    'Content-Type: text/html; charset=utf-8',
    'Content-Transfer-Encoding: quoted-printable',
    '',
    quotedPrintable(msg.html),
    `--${boundary}--`,
    '',
  ];

  return [...lines, ...body].join(CRLF);
}
