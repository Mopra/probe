import { describe, expect, it } from 'vitest';

import {
  applyFooter,
  clickUrl,
  dataNoticeUrl,
  renderFooter,
  rewriteEvidenceUrl,
  unsubscribeUrl,
} from './footer';

const INPUT = {
  fromName: 'Morten Pradsgaard',
  fromEmail: 'morten@mail.exit1.dev',
  productName: 'exit1.dev',
  postalAddress: 'Pradsgaard Labs, Vestergade 12, 8000 Aarhus C, Denmark',
  unsubscribeUrl: 'https://probe.exit1.dev/u/un_token',
  dataNoticeUrl: 'https://probe.exit1.dev/data',
};

describe('renderFooter', () => {
  it('carries every required element in both variants', () => {
    const footer = renderFooter(INPUT);
    for (const value of [INPUT.fromName, INPUT.fromEmail, INPUT.postalAddress, INPUT.unsubscribeUrl, INPUT.dataNoticeUrl]) {
      expect(footer.text).toContain(value);
      expect(footer.html).toContain(value);
    }
  });

  it('states the contact once policy (§9.2.6)', () => {
    const footer = renderFooter(INPUT);
    expect(footer.text).toContain('This is the only email you will ever get from me. No follow-ups, no sequence.');
    expect(footer.html).toContain('This is the only email you will ever get from me. No follow-ups, no sequence.');
  });

  it('puts the postal address on the first line, which is how the lint finds the footer boundary', () => {
    const footer = renderFooter(INPUT);
    expect(footer.text.split('\n')[0]).toBe(INPUT.postalAddress);
  });

  it('introduces exactly two links, both permitted', () => {
    const footer = renderFooter(INPUT);
    const hrefs = [...footer.html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
    expect(hrefs).toEqual([INPUT.unsubscribeUrl, INPUT.dataNoticeUrl]);
  });

  it('is inline styled, small and muted', () => {
    const footer = renderFooter(INPUT);
    expect(footer.html).toContain('font-size:12px');
    expect(footer.html).toContain('color:#767676');
    expect(footer.html).not.toContain('<style');
    expect(footer.html).not.toContain('class=');
  });

  it('escapes html in the postal address', () => {
    const footer = renderFooter({ ...INPUT, postalAddress: 'Labs & Co, <street>, Denmark' });
    expect(footer.html).toContain('Labs &amp; Co, &lt;street&gt;, Denmark');
    expect(footer.text).toContain('Labs & Co, <street>, Denmark');
  });
});

describe('applyFooter', () => {
  const footer = renderFooter(INPUT);

  it('injects before </body> when there is one', () => {
    const html = '<html><body><p>Finding.</p></body></html>';
    const out = applyFooter({ html, text: 'Finding.', footer });
    expect(out.html.indexOf(INPUT.postalAddress)).toBeGreaterThan(out.html.indexOf('<p>Finding.</p>'));
    expect(out.html.indexOf(INPUT.postalAddress)).toBeLessThan(out.html.indexOf('</body>'));
    expect(out.html.endsWith('</body></html>')).toBe(true);
  });

  it('matches </body> case insensitively', () => {
    const html = '<HTML><BODY><p>Finding.</p></BODY></HTML>';
    const out = applyFooter({ html, text: 'Finding.', footer });
    expect(out.html.indexOf(INPUT.postalAddress)).toBeLessThan(out.html.indexOf('</BODY>'));
  });

  it('appends when there is no </body>', () => {
    const html = '<p>Finding.</p>';
    const out = applyFooter({ html, text: 'Finding.', footer });
    expect(out.html.startsWith('<p>Finding.</p>')).toBe(true);
    expect(out.html).toContain(INPUT.postalAddress);
  });

  it('separates the text footer from the body with a blank line', () => {
    const out = applyFooter({ html: '<p>Finding.</p>', text: 'Finding.   \n', footer });
    expect(out.text).toBe(`Finding.\n\n${footer.text}\n`);
  });

  it('never mutates its inputs', () => {
    const html = '<html><body><p>Finding.</p></body></html>';
    const text = 'Finding.';
    const footerCopy = { html: footer.html, text: footer.text };
    const out = applyFooter({ html, text, footer });
    expect(html).toBe('<html><body><p>Finding.</p></body></html>');
    expect(text).toBe('Finding.');
    expect(footer).toEqual(footerCopy);
    expect(out.html).not.toBe(html);
  });
});

describe('rewriteEvidenceUrl', () => {
  const evidenceUrl = 'https://exit1.dev/probe/01J8?region=eu-west-1&full=1';
  const click = 'https://probe.exit1.dev/c/ck_token';

  it('rewrites double quoted, single quoted and bare occurrences', () => {
    const html = [
      `<a href="${evidenceUrl}">log</a>`,
      `<a href='${evidenceUrl}'>log</a>`,
      `<p>${evidenceUrl}</p>`,
    ].join('\n');
    const text = `Full log: ${evidenceUrl}`;
    const out = rewriteEvidenceUrl({ html, text, evidenceUrl, clickUrl: click });
    expect(out.html).not.toContain(evidenceUrl);
    expect(out.html.match(new RegExp(click.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))).toHaveLength(3);
    expect(out.text).toBe(`Full log: ${click}`);
  });

  it('rewrites an html escaped href as well', () => {
    const html = `<a href="${evidenceUrl.replace(/&/g, '&amp;')}">log</a>`;
    const out = rewriteEvidenceUrl({ html, text: '', evidenceUrl, clickUrl: click });
    expect(out.html).toBe(`<a href="${click}">log</a>`);
  });

  it('treats regex metacharacters in the url as literal text', () => {
    const weird = 'https://exit1.dev/probe/a+b(c)?x=1';
    const html = `<a href="${weird}">log</a>`;
    const out = rewriteEvidenceUrl({ html, text: weird, evidenceUrl: weird, clickUrl: click });
    expect(out.html).toBe(`<a href="${click}">log</a>`);
    expect(out.text).toBe(click);
  });

  it('leaves the bodies alone when there is no evidence url', () => {
    const out = rewriteEvidenceUrl({ html: '<p>x</p>', text: 'x', evidenceUrl: '', clickUrl: click });
    expect(out).toEqual({ html: '<p>x</p>', text: 'x' });
  });
});

describe('url builders', () => {
  it('builds the three absolute urls', () => {
    expect(unsubscribeUrl('https://probe.exit1.dev', 'tok')).toBe('https://probe.exit1.dev/u/tok');
    expect(clickUrl('https://probe.exit1.dev', 'tok')).toBe('https://probe.exit1.dev/c/tok');
    expect(dataNoticeUrl('https://probe.exit1.dev')).toBe('https://probe.exit1.dev/data');
  });

  it('tolerates a trailing slash on the base', () => {
    expect(unsubscribeUrl('https://probe.exit1.dev/', 'tok')).toBe('https://probe.exit1.dev/u/tok');
    expect(dataNoticeUrl('https://probe.exit1.dev//')).toBe('https://probe.exit1.dev/data');
  });
});
