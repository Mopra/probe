import { describe, expect, it } from 'vitest';
import { composeMessage, describeLint, productDomainOf } from './compose';

// A body in the shape §9.2 actually asks for: the finding first, the fix, the
// provenance sentence, the contact-once statement, and exactly one link out to
// the evidence. Everything else the email needs is appended by the footer.
const EVIDENCE = 'https://exit1.dev/probe/01JQ7Z8R5K2M4N6P8Q0S2T4V6X';

const PARAS = [
  'Your /v1/usage endpoint returned 502 on 3 of 20 requests between 06:14 and ' +
    '07:49 UTC this morning. All three failures came from probes that sent no ' +
    'Accept header. The seventeen that set Accept: application/json returned 200 every time.',
  'The fix: your gateway falls back to a default route when Accept is absent, and that ' +
    'route has no handler for /v1/usage. Setting a default of application/json at the ' +
    'gateway removes the 502 and the ambiguity behind it.',
  'I run exit1.dev, an uptime monitor. You launched on Hacker News this morning, so I ' +
    'pointed it at your public surface for ninety minutes. I found your address on your ' +
    '/contact page. Where your data lives and how to have it deleted is linked below.',
  'This is the only email you will ever get from me. No follow-ups, no sequence.',
];

function bodies(evidenceUrl: string | null): { html: string; text: string } {
  const link = evidenceUrl ? `Full log, with request ids and timings: ${evidenceUrl}` : null;
  const text = [...PARAS, ...(link ? [link] : [])].join('\n\n');
  const html = [
    '<html>',
    '  <body>',
    ...PARAS.map((p) => `    <p>${p}</p>`),
    ...(evidenceUrl
      ? [`    <p><a href="${evidenceUrl}">Full log, with request ids and timings</a></p>`]
      : []),
    '  </body>',
    '</html>',
  ].join('\n');
  return { html, text };
}

function input(over: Partial<Parameters<typeof composeMessage>[0]> = {}) {
  const b = bodies(EVIDENCE);
  return {
    subject: '/v1/usage returned 502 on 3 of 20 probes this morning',
    html: b.html,
    text: b.text,
    evidenceUrl: EVIDENCE,
    productName: 'exit1.dev',
    fromName: 'Morten Pradsgaard',
    fromEmail: 'morten@mail.exit1.dev',
    replyTo: 'morten@mail.exit1.dev',
    to: 'priya@meterbase.dev',
    postalAddress: 'Pradsgaard Labs, Vestergade 12, 8000 Aarhus C, Denmark',
    baseUrl: 'https://probe.exit1.dev',
    unsubToken: 'UNSUB_TOKEN_AAA',
    clickToken: 'CLICK_TOKEN_BBB',
    ...over,
  };
}

/** Undo quoted-printable so link and footer assertions see real text. */
function decodeQp(mime: string): string {
  return mime
    .replace(/=\r?\n/g, '')
    .replace(/=([0-9A-Fa-f]{2})/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

describe('composeMessage', () => {
  it('produces a mailable email that passes the copy lint', () => {
    const out = composeMessage(input());
    expect(describeLint(out.lint)).toBe('');
    expect(out.lint.ok).toBe(true);
  });

  it('rewrites the evidence url through /c/:token and leaves no trace of the original', () => {
    const out = composeMessage(input());
    expect(out.links.click).toBe('https://probe.exit1.dev/c/CLICK_TOKEN_BBB');
    expect(out.html).toContain(out.links.click);
    expect(out.text).toContain(out.links.click);
    expect(out.html).not.toContain(EVIDENCE);
    expect(out.text).not.toContain(EVIDENCE);
  });

  it('emits exactly the three permitted links and no fourth', () => {
    const out = composeMessage(input());
    const links = [...new Set(decodeQp(out.mime).match(/https?:\/\/[^\s"'<>)]+/g) ?? [])];
    expect(links.sort()).toEqual(
      [
        'https://probe.exit1.dev/c/CLICK_TOKEN_BBB',
        'https://probe.exit1.dev/data',
        'https://probe.exit1.dev/u/UNSUB_TOKEN_AAA',
      ].sort(),
    );
  });

  it('appends the footer to both body variants', () => {
    const out = composeMessage(input());
    for (const body of [out.html, out.text]) {
      expect(body).toContain('Pradsgaard Labs, Vestergade 12, 8000 Aarhus C, Denmark');
      expect(body).toContain('https://probe.exit1.dev/u/UNSUB_TOKEN_AAA');
      expect(body).toContain('https://probe.exit1.dev/data');
    }
    // The footer goes inside the document, not after it: a trailing block
    // outside </body> is at the mercy of the client's parser.
    expect(out.html.indexOf('</body>')).toBeGreaterThan(out.html.indexOf('Pradsgaard Labs'));
  });

  it('carries the RFC 8058 one-click unsubscribe headers', () => {
    const { mime } = composeMessage(input());
    expect(mime).toContain('List-Unsubscribe: <https://probe.exit1.dev/u/UNSUB_TOKEN_AAA>');
    expect(mime).toContain('List-Unsubscribe-Post: List-Unsubscribe=One-Click');
  });

  it('never splices a click url into a proof that carries no evidence url', () => {
    const b = bodies(null);
    const out = composeMessage(input({ evidenceUrl: null, html: b.html, text: b.text }));
    expect(out.links.evidence).toBeNull();
    expect(out.html).not.toContain('/c/CLICK_TOKEN_BBB');
    // And it is a lint failure rather than a quietly linkless email: §9.2.5
    // permits exactly three links and the evidence link is one of them.
    expect(out.lint.ok).toBe(false);
    expect(out.lint.violations.some((v) => v.code === 'missing_permitted_link')).toBe(true);
  });

  it('is deterministic in everything a reader or the lint can see', () => {
    // apps/web renders the queue preview and apps/worker renders the dispatch.
    // Only the Message-ID and Date may differ between two composes, which is
    // what makes "view raw .eml" an honest preview of the real bytes.
    const a = composeMessage(input());
    const b = composeMessage(input());
    expect(b.html).toBe(a.html);
    expect(b.text).toBe(a.text);
    expect(b.lint).toEqual(a.lint);
    // The Message-ID, the Date and the multipart boundary are freshly random
    // on every compose. Normalise those three and the bytes must match.
    const strip = (m: string) =>
      m
        .replace(/^(Message-ID|Date):.*$/gm, '')
        .replace(/=_probe_[0-9a-f]+/g, '=_probe_BOUNDARY');
    expect(strip(b.mime)).toBe(strip(a.mime));
  });

  it('still composes when the generator body is empty, and fails the lint loudly', () => {
    const out = composeMessage(input({ html: '', text: '', subject: '' }));
    expect(out.lint.ok).toBe(false);
    expect(out.lint.violations.some((v) => v.code === 'empty_subject')).toBe(true);
    expect(out.mime).toContain('List-Unsubscribe:');
  });
});

describe('productDomainOf', () => {
  it('normalises whatever campaigns.product happens to hold', () => {
    expect(productDomainOf('exit1.dev')).toBe('exit1.dev');
    expect(productDomainOf('https://exit1.dev')).toBe('exit1.dev');
    expect(productDomainOf('https://www.exit1.dev/pricing')).toBe('exit1.dev');
    expect(productDomainOf('  EXIT1.DEV  ')).toBe('exit1.dev');
    expect(productDomainOf('exit1.dev:8443')).toBe('exit1.dev');
  });
});
