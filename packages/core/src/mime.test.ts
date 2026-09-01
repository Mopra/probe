import { describe, expect, it } from 'vitest';

import { buildMime } from './mime';
import type { OutboundMessage } from './mime';

const CRLF = '\r\n';

// --- a mail client's worth of parsing, so the assertions are about the bytes -

function splitMessage(raw: string): { headers: Record<string, string>; body: string } {
  const at = raw.indexOf(`${CRLF}${CRLF}`);
  expect(at).toBeGreaterThan(0);
  const block = raw.slice(0, at);
  const body = raw.slice(at + 4);
  const unfolded = block.replace(/\r\n[ \t]+/g, ' ');
  const headers: Record<string, string> = {};
  for (const line of unfolded.split(CRLF)) {
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }
  return { headers, body };
}

function decodeEncodedWords(value: string): string {
  return value
    .replace(/(\?=)\s+(?==\?)/g, '$1')
    .replace(/=\?utf-8\?B\?([^?]*)\?=/gi, (_m, b64: string) => Buffer.from(b64, 'base64').toString('utf8'));
}

function decodeQuotedPrintable(input: string): string {
  const soft = input.replace(/=\r\n/g, '');
  const bytes: number[] = [];
  for (let i = 0; i < soft.length; ) {
    if (soft[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(soft.slice(i + 1, i + 3))) {
      bytes.push(parseInt(soft.slice(i + 1, i + 3), 16));
      i += 3;
      continue;
    }
    const code = soft.charCodeAt(i);
    bytes.push(code);
    i += 1;
  }
  return Buffer.from(Uint8Array.from(bytes)).toString('utf8');
}

function parseParts(raw: string): Array<{ headers: Record<string, string>; content: string }> {
  const { headers, body } = splitMessage(raw);
  const boundaryMatch = /boundary="([^"]+)"/.exec(headers['content-type'] ?? '');
  expect(boundaryMatch).not.toBeNull();
  const boundary = (boundaryMatch as RegExpExecArray)[1];
  const chunks = body.split(`--${boundary}`);
  expect(chunks[chunks.length - 1].trim()).toBe('--');
  return chunks.slice(1, -1).map((chunk) => {
    const trimmed = chunk.replace(/^\r\n/, '');
    const at = trimmed.indexOf(`${CRLF}${CRLF}`);
    const partHeaders: Record<string, string> = {};
    for (const line of trimmed.slice(0, at).split(CRLF)) {
      const colon = line.indexOf(':');
      if (colon < 0) continue;
      partHeaders[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
    }
    return { headers: partHeaders, content: trimmed.slice(at + 4).replace(/\r\n$/, '') };
  });
}

const BASE: OutboundMessage = {
  fromName: 'Morten Pradsgaard',
  fromEmail: 'morten@mail.exit1.dev',
  to: 'priya@meterbase.dev',
  replyTo: 'morten@mail.exit1.dev',
  subject: '/v1/usage returned 502 on 3 of 20 probes this morning',
  html: '<html><body><p>Your /v1/usage endpoint returned 502.</p></body></html>',
  text: 'Your /v1/usage endpoint returned 502.',
  unsubscribeUrl: 'https://probe.exit1.dev/u/un_token',
  date: new Date(Date.UTC(2026, 8, 1, 7, 30, 0)),
};

describe('buildMime, headers', () => {
  it('writes the required headers', () => {
    const { headers } = splitMessage(buildMime(BASE));
    expect(headers.from).toBe('"Morten Pradsgaard" <morten@mail.exit1.dev>');
    expect(headers.to).toBe('priya@meterbase.dev');
    expect(headers['reply-to']).toBe('morten@mail.exit1.dev');
    expect(headers.subject).toBe(BASE.subject);
    expect(headers.date).toBe('Tue, 01 Sep 2026 07:30:00 +0000');
    expect(headers['mime-version']).toBe('1.0');
    expect(headers['content-type']).toMatch(/^multipart\/alternative; boundary="----=_probe_[0-9a-f]{24}"$/);
  });

  it('omits Reply-To when there is none', () => {
    const { headers } = splitMessage(buildMime({ ...BASE, replyTo: undefined }));
    expect(headers['reply-to']).toBeUndefined();
  });

  it('generates a Message-ID on the sending domain', () => {
    const { headers } = splitMessage(buildMime(BASE));
    expect(headers['message-id']).toMatch(
      /^<[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}@mail\.exit1\.dev>$/,
    );
  });

  it('keeps a supplied Message-ID and adds the angle brackets', () => {
    const { headers } = splitMessage(buildMime({ ...BASE, messageId: 'abc-123@mail.exit1.dev' }));
    expect(headers['message-id']).toBe('<abc-123@mail.exit1.dev>');
  });

  it('writes the RFC 8058 one click unsubscribe headers', () => {
    const { headers } = splitMessage(
      buildMime({ ...BASE, unsubscribeMailto: 'unsubscribe@mail.exit1.dev' }),
    );
    expect(headers['list-unsubscribe']).toBe(
      '<https://probe.exit1.dev/u/un_token>, <mailto:unsubscribe@mail.exit1.dev>',
    );
    expect(headers['list-unsubscribe-post']).toBe('List-Unsubscribe=One-Click');
  });

  it('writes only the https variant when there is no mailto', () => {
    const { headers } = splitMessage(buildMime(BASE));
    expect(headers['list-unsubscribe']).toBe('<https://probe.exit1.dev/u/un_token>');
  });

  it('RFC 2047 encodes a non ascii display name and subject', () => {
    const raw = buildMime({
      ...BASE,
      fromName: 'Morten Pradsgaard Ærø',
      subject: 'Dit /v1/forbrug svarede 502 på 3 af 20 målinger i morges',
    });
    const { headers } = splitMessage(raw);
    expect(headers.subject).toContain('=?utf-8?B?');
    expect(decodeEncodedWords(headers.subject)).toBe('Dit /v1/forbrug svarede 502 på 3 af 20 målinger i morges');
    expect(decodeEncodedWords(headers.from)).toBe('Morten Pradsgaard Ærø <morten@mail.exit1.dev>');
  });

  it('appends extra headers but never lets them override probe\'s own', () => {
    const raw = buildMime({
      ...BASE,
      headers: {
        'X-Probe-Campaign': 'exit1',
        From: 'attacker@example.com',
        'list-unsubscribe': '<https://example.com/evil>',
      },
    });
    const { headers } = splitMessage(raw);
    expect(headers['x-probe-campaign']).toBe('exit1');
    expect(headers.from).toBe('"Morten Pradsgaard" <morten@mail.exit1.dev>');
    expect(headers['list-unsubscribe']).toBe('<https://probe.exit1.dev/u/un_token>');
  });

  it('makes header injection impossible', () => {
    const raw = buildMime({
      ...BASE,
      to: 'priya@meterbase.dev\r\nBcc: everyone@example.com',
      subject: 'clean\r\nX-Injected: yes',
      headers: { 'X-Note': 'a\r\nX-Also-Injected: yes' },
    });
    const { headers } = splitMessage(raw);
    const headerBlock = raw.slice(0, raw.indexOf(`${CRLF}${CRLF}`));
    // The smuggled text survives as part of a value, but it never becomes a
    // header of its own, which is the only thing that matters.
    expect(headerBlock.split(CRLF).some((line) => /^(bcc|x-injected|x-also-injected):/i.test(line))).toBe(false);
    expect(headers['x-injected']).toBeUndefined();
    expect(headers['x-also-injected']).toBeUndefined();
    expect(headers.to).toBe('priya@meterbase.dev Bcc: everyone@example.com');
  });

  it('uses CRLF everywhere and never a bare LF', () => {
    const raw = buildMime(BASE);
    expect(raw.replace(/\r\n/g, '')).not.toContain('\n');
    expect(raw.replace(/\r\n/g, '')).not.toContain('\r');
  });
});

describe('buildMime, body', () => {
  it('is multipart/alternative with text first and html second', () => {
    const parts = parseParts(buildMime(BASE));
    expect(parts).toHaveLength(2);
    expect(parts[0].headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(parts[0].headers['content-transfer-encoding']).toBe('quoted-printable');
    expect(parts[1].headers['content-type']).toBe('text/html; charset=utf-8');
    expect(parts[1].headers['content-transfer-encoding']).toBe('quoted-printable');
    expect(decodeQuotedPrintable(parts[0].content)).toBe(BASE.text);
    expect(decodeQuotedPrintable(parts[1].content)).toBe(BASE.html);
  });

  it('round trips a long line, non ascii, an equals sign and trailing whitespace', () => {
    const text = [
      `A very long single line that has to soft wrap: ${'the gateway returned 502 for every request without an Accept header. '.repeat(6)}`,
      'Non ascii: æøå ÆØÅ 三 🙂 and an equals sign = right here.',
      'trailing spaces   ',
      '',
      'done.',
    ].join('\n');
    const raw = buildMime({ ...BASE, text });
    const parts = parseParts(raw);
    expect(decodeQuotedPrintable(parts[0].content).replace(/\r\n/g, '\n')).toBe(text);
  });

  it('keeps every encoded body line at 76 characters or fewer', () => {
    const text = `${'x'.repeat(400)}\n${'æ'.repeat(200)}`;
    const raw = buildMime({ ...BASE, text, html: `<p>${'y'.repeat(400)}</p>` });
    for (const part of parseParts(raw)) {
      for (const line of part.content.split(CRLF)) expect(line.length).toBeLessThanOrEqual(76);
    }
  });

  it('folds the headers to 78 characters or fewer', () => {
    const raw = buildMime({
      ...BASE,
      subject: 'A subject long enough that a mail client would otherwise have to scroll it sideways all day',
    });
    const headerBlock = raw.slice(0, raw.indexOf(`${CRLF}${CRLF}`));
    for (const line of headerBlock.split(CRLF)) expect(line.length).toBeLessThanOrEqual(78);
  });

  it('never splits a multi byte character or an escape across a soft wrap', () => {
    const text = 'æ'.repeat(120);
    const parts = parseParts(buildMime({ ...BASE, text }));
    for (const line of parts[0].content.split(CRLF)) {
      const body = line.endsWith('=') ? line.slice(0, -1) : line;
      // Every escape is whole, and the escapes on a line always form complete
      // two byte sequences, so the count of '=' escapes is even for 'æ'.
      expect(body.replace(/=[0-9A-F]{2}/g, '')).toBe('');
      expect((body.match(/=[0-9A-F]{2}/g) ?? []).length % 2).toBe(0);
    }
    expect(decodeQuotedPrintable(parts[0].content)).toBe(text);
  });

  it('encodes trailing whitespace so an MTA cannot eat it', () => {
    const parts = parseParts(buildMime({ ...BASE, text: 'two spaces  ' }));
    expect(parts[0].content).toBe('two spaces=20=20');
  });

  it('closes with the final boundary', () => {
    const raw = buildMime(BASE);
    const boundary = /boundary="([^"]+)"/.exec(raw)?.[1] as string;
    expect(raw.endsWith(`--${boundary}--${CRLF}`)).toBe(true);
  });
});
