import { describe, expect, it } from 'vitest';

import { applyFooter, dataNoticeUrl, renderFooter, unsubscribeUrl, clickUrl } from './footer';
import { FORBIDDEN_PATTERNS, lintCopy, placeholderPostalAddress } from './lint';
import type { LintCode, LintInput } from './lint';

const BASE = 'https://probe.exit1.dev';
const CLICK = clickUrl(BASE, 'ck_0123456789abcdef');
const UNSUB = unsubscribeUrl(BASE, 'un_0123456789abcdef');
const DATA = dataNoticeUrl(BASE);
const POSTAL = 'Pradsgaard Labs, Vestergade 12, 8000 Aarhus C, Denmark';
const FROM_NAME = 'Morten Pradsgaard';
const FROM_EMAIL = 'morten@mail.exit1.dev';

const SUBJECT = '/v1/usage returned 502 on 3 of 20 probes this morning';

const BODY_TEXT = [
  '/v1/usage returned 502 on 3 of 20 probes this morning, all of them requests sent without an Accept header.',
  '',
  'The failures clustered between 06:14 and 07:49 UTC. The other 17 probes came back 200 in under 300ms, so this was not a general outage.',
  '',
  'The fix: the gateway falls through to a 502 when content negotiation fails. Setting a default response type on the route, or making the Accept header optional, clears it.',
  '',
  `Full log, with request ids and per region timings: ${CLICK}`,
  '',
  'I run exit1.dev, an uptime monitor. You launched on Hacker News this morning, so I pointed it at your site. I found your address on your /contact page.',
  '',
  'This is the only email you will ever get from me. No follow-ups, no sequence.',
].join('\n');

const BODY_HTML = [
  '<html><body>',
  '<p>/v1/usage returned 502 on 3 of 20 probes this morning, all of them requests sent without an Accept header.</p>',
  '<p>The failures clustered between 06:14 and 07:49 UTC. The other 17 probes came back 200 in under 300ms, so this was not a general outage.</p>',
  '<p>The fix: the gateway falls through to a 502 when content negotiation fails. Setting a default response type on the route, or making the Accept header optional, clears it.</p>',
  `<p>Full log, with request ids and per region timings: <a href="${CLICK}">${CLICK}</a></p>`,
  '<p>I run exit1.dev, an uptime monitor. You launched on Hacker News this morning, so I pointed it at your site. I found your address on your /contact page.</p>',
  '<p>This is the only email you will ever get from me. No follow-ups, no sequence.</p>',
  '</body></html>',
].join('\n');

/** The golden email: generator body plus the footer probe appends, exactly as
 *  the send path composes it. */
function golden(overrides: Partial<LintInput> = {}): LintInput {
  const footer = renderFooter({
    fromName: FROM_NAME,
    fromEmail: FROM_EMAIL,
    productName: 'exit1.dev',
    postalAddress: POSTAL,
    unsubscribeUrl: UNSUB,
    dataNoticeUrl: DATA,
  });
  const withFooter = applyFooter({ html: BODY_HTML, text: BODY_TEXT, footer });
  return {
    subject: SUBJECT,
    html: withFooter.html,
    text: withFooter.text,
    productName: 'exit1.dev',
    productDomain: 'exit1.dev',
    evidenceUrl: CLICK,
    unsubscribeUrl: UNSUB,
    dataNoticeUrl: DATA,
    postalAddress: POSTAL,
    fromName: FROM_NAME,
    fromEmail: FROM_EMAIL,
    ...overrides,
  };
}

/** Rebuilds the golden input from a modified generator body. */
function fromBody(html: string, text: string, overrides: Partial<LintInput> = {}): LintInput {
  const footer = renderFooter({
    fromName: FROM_NAME,
    fromEmail: FROM_EMAIL,
    productName: 'exit1.dev',
    postalAddress: POSTAL,
    unsubscribeUrl: UNSUB,
    dataNoticeUrl: DATA,
  });
  const withFooter = applyFooter({ html, text, footer });
  return golden({ html: withFooter.html, text: withFooter.text, ...overrides });
}

function codes(input: LintInput): LintCode[] {
  return lintCopy(input).violations.map((v) => v.code);
}

describe('lintCopy, the golden email', () => {
  it('passes end to end with no violations', () => {
    const result = lintCopy(golden());
    expect(result.violations).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('finds the footer when the html escaped the postal address', () => {
    // The footer element check has to survive html escaping: '&' in a real
    // address becomes '&amp;' in the html half and the lint must still match it
    // against the configured string.
    const postal = 'Pradsgaard Labs, Vestergade 12 & 14, 8000 Aarhus, Denmark';
    const footer = renderFooter({
      fromName: FROM_NAME,
      fromEmail: FROM_EMAIL,
      productName: 'exit1.dev',
      postalAddress: postal,
      unsubscribeUrl: UNSUB,
      dataNoticeUrl: DATA,
    });
    const withFooter = applyFooter({ html: BODY_HTML, text: BODY_TEXT, footer });
    const result = lintCopy(
      golden({ html: withFooter.html, text: withFooter.text, postalAddress: postal }),
    );
    expect(result.violations).toEqual([]);
  });
});

describe('the postal address must be a real one (§9.2.7)', () => {
  // This is the rule the README always claimed existed and did not. The footer
  // element check above only proves the configured string reached both bodies,
  // which a placeholder satisfies perfectly, so without this the committed
  // probe.toml placeholder shipped in the CAN-SPAM footer of every real email.

  function withPostal(postal: string): LintCode[] {
    const footer = renderFooter({
      fromName: FROM_NAME,
      fromEmail: FROM_EMAIL,
      productName: 'exit1.dev',
      postalAddress: postal,
      unsubscribeUrl: UNSUB,
      dataNoticeUrl: DATA,
    });
    const withFooter = applyFooter({ html: BODY_HTML, text: BODY_TEXT, footer });
    return codes(golden({ html: withFooter.html, text: withFooter.text, postalAddress: postal }));
  }

  it('blocks the exact placeholder that ships in probe.toml', () => {
    expect(withPostal('Pradsgaard Labs, <street>, <zip> <city>, Denmark')).toContain(
      'placeholder_postal_address',
    );
  });

  it('blocks a placeholder whose brackets were stripped but whose words were not', () => {
    for (const address of [
      'Pradsgaard Labs, your street 1, 1234 your city, Denmark',
      'Pradsgaard Labs, Street Name 1, 8000 Aarhus, Denmark',
      'Pradsgaard Labs, TODO, 8000 Aarhus, Denmark',
      'Pradsgaard Labs, Vestergade 12, zip code 8000 Aarhus, Denmark',
    ]) {
      expect(withPostal(address), address).toContain('placeholder_postal_address');
    }
  });

  it('blocks an address with no street number or postcode', () => {
    expect(withPostal('Pradsgaard Labs, Aarhus, Denmark')).toContain(
      'placeholder_postal_address',
    );
  });

  it('passes a real Danish address', () => {
    expect(withPostal('Pradsgaard Labs, Vestergade 12, 8000 Aarhus, Denmark')).not.toContain(
      'placeholder_postal_address',
    );
  });

  it('passes a real address whose street name embeds a placeholder word', () => {
    // 'Bakerstreet' and 'Oxford Street 5' are real; the word rule is matched on
    // boundaries so a street name is not a false positive. This is the case
    // that decides whether the rule is usable or just annoying.
    for (const address of [
      'Pradsgaard Labs, Bakerstreet 221B, 1000 London, United Kingdom',
      'Pradsgaard Labs, Oxford Street 5, 8000 Aarhus, Denmark',
      'Pradsgaard Labs, Cityringen 4, 2100 Copenhagen, Denmark',
    ]) {
      expect(withPostal(address), address).not.toContain('placeholder_postal_address');
    }
  });

  it('reports it as one violation covering both bodies', () => {
    const postal = 'Pradsgaard Labs, <street>, <zip> <city>, Denmark';
    const footer = renderFooter({
      fromName: FROM_NAME,
      fromEmail: FROM_EMAIL,
      productName: 'exit1.dev',
      postalAddress: postal,
      unsubscribeUrl: UNSUB,
      dataNoticeUrl: DATA,
    });
    const withFooter = applyFooter({ html: BODY_HTML, text: BODY_TEXT, footer });
    const hits = lintCopy(
      golden({ html: withFooter.html, text: withFooter.text, postalAddress: postal }),
    ).violations.filter((v) => v.code === 'placeholder_postal_address');
    expect(hits).toHaveLength(1);
    expect(hits[0]?.where).toBe('both');
    expect(hits[0]?.message).toContain('probe.toml');
  });
});

describe("urls on the recipient's own domain (§9.2.5)", () => {
  // The three-link rule forbids a FOURTH FUNNEL: somewhere we want the reader
  // to go. A url pointing at the recipient's own broken page is the opposite of
  // that. It is the evidence, and it is what makes "verify it in thirty
  // seconds" literally true rather than an instruction to reconstruct a path.
  //
  // This was found by running the real exit1 generator's output through this
  // lint: four of its five finding kinds quote the founder's own url, and all
  // four were being dropped as generator_failed.

  const BROKEN_LINK_TEXT = [
    'Your landing page links to https://meterbase.dev/status, which returned HTTP 404.',
    '',
    'Two links on https://meterbase.dev/ point at pages on your own domain that do not resolve.',
    '',
    'These are usually pages that were renamed or never shipped, with the nav still pointing at the old path.',
    '',
    `Full log, with request ids and per region timings: ${CLICK}`,
    '',
    'I run exit1.dev, an uptime monitor. You launched on Hacker News this morning, so I pointed it at your site. I found your address on your /contact page.',
    '',
    'This is the only email you will ever get from me. No follow-ups, no sequence.',
  ].join('\n');

  const BROKEN_LINK_HTML = [
    '<html><body>',
    '<p>Your landing page links to https://meterbase.dev/status, which returned HTTP 404.</p>',
    '<p>Two links on https://meterbase.dev/ point at pages on your own domain that do not resolve.</p>',
    '<p>These are usually pages that were renamed or never shipped, with the nav still pointing at the old path.</p>',
    `<p>Full log, with request ids and per region timings: <a href="${CLICK}">${CLICK}</a></p>`,
    '<p>I run exit1.dev, an uptime monitor. You launched on Hacker News this morning, so I pointed it at your site. I found your address on your /contact page.</p>',
    '<p>This is the only email you will ever get from me. No follow-ups, no sequence.</p>',
    '</body></html>',
  ].join('\n');

  it('permits them when the recipient domain is known', () => {
    const result = lintCopy(
      fromBody(BROKEN_LINK_HTML, BROKEN_LINK_TEXT, { recipientDomain: 'meterbase.dev' }),
    );
    expect(result.violations).toEqual([]);
  });

  it('permits a subdomain of the recipient domain', () => {
    // A finding about api.theirsite.dev is still a finding about their surface.
    const text = BROKEN_LINK_TEXT.replace('meterbase.dev/status', 'api.meterbase.dev/v1/usage');
    const html = BROKEN_LINK_HTML.replace('meterbase.dev/status', 'api.meterbase.dev/v1/usage');
    expect(
      lintCopy(fromBody(html, text, { recipientDomain: 'meterbase.dev' })).violations,
    ).toEqual([]);
  });

  it('treats the www form and the apex as the same domain', () => {
    const text = BROKEN_LINK_TEXT.replace('https://meterbase.dev/status', 'https://www.meterbase.dev/status');
    const html = BROKEN_LINK_HTML.replace('https://meterbase.dev/status', 'https://www.meterbase.dev/status');
    expect(
      lintCopy(fromBody(html, text, { recipientDomain: 'www.meterbase.dev' })).violations,
    ).toEqual([]);
  });

  it('still refuses a url on any OTHER domain', () => {
    // The rule is scoped to the recipient. A link anywhere else is still a
    // fourth link, whoever owns it.
    const text = BROKEN_LINK_TEXT.replace('https://meterbase.dev/status', 'https://exit1.dev/how-it-works');
    const html = BROKEN_LINK_HTML.replace('https://meterbase.dev/status', 'https://exit1.dev/how-it-works');
    expect(
      codes(fromBody(html, text, { recipientDomain: 'meterbase.dev' })),
    ).toContain('link_not_permitted');
  });

  it('refuses them when the recipient domain is not supplied', () => {
    // The stricter reading is the default: a caller that does not know whose
    // email it is composing gets the three-link rule and nothing more.
    expect(codes(fromBody(BROKEN_LINK_HTML, BROKEN_LINK_TEXT))).toContain('link_not_permitted');
  });

  it('does not let the recipient domain satisfy a REQUIRED link', () => {
    // Permitting their url must not make it stand in for the evidence link.
    const withoutEvidence = BROKEN_LINK_TEXT.replace(
      `Full log, with request ids and per region timings: ${CLICK}`,
      'Full log, with request ids and per region timings: see below.',
    );
    const htmlWithoutEvidence = BROKEN_LINK_HTML.replace(
      `<p>Full log, with request ids and per region timings: <a href="${CLICK}">${CLICK}</a></p>`,
      '<p>Full log, with request ids and per region timings: see below.</p>',
    );
    expect(
      codes(fromBody(htmlWithoutEvidence, withoutEvidence, { recipientDomain: 'meterbase.dev' })),
    ).toContain('missing_permitted_link');
  });

  it('does not permit an IMAGE from the recipient domain', () => {
    // A remote image is open tracking by another name (§8.7) whoever hosts it,
    // and relaxing the link rule must not relax that one too.
    const html = BROKEN_LINK_HTML.replace(
      '</body>',
      '<img src="https://meterbase.dev/logo.png" width="200"></body>',
    );
    expect(
      codes(fromBody(html, BROKEN_LINK_TEXT, { recipientDomain: 'meterbase.dev' })),
    ).toContain('tracking_pixel');
  });
});

describe('placeholderPostalAddress', () => {
  it('explains itself rather than just refusing', () => {
    // The message is the whole value of this rule: the operator reads it in the
    // dry-run output and has to know what to type.
    expect(placeholderPostalAddress('Labs, <street>, Denmark')).toContain('angle brackets');
    expect(placeholderPostalAddress('Labs, Aarhus, Denmark')).toContain('postcode');
    expect(placeholderPostalAddress('Labs, your city 1, Denmark')).toContain('placeholder');
    expect(placeholderPostalAddress('')).toContain('No postal address');
  });

  it('returns null for an address that is fine', () => {
    expect(placeholderPostalAddress('Pradsgaard Labs, Vestergade 12, 8000 Aarhus, DK')).toBeNull();
  });
});

describe('lintCopy, subject', () => {
  it('flags an empty subject', () => {
    expect(codes(golden({ subject: '   ' }))).toContain('empty_subject');
  });

  it('flags a subject that is only a greeting', () => {
    expect(codes(golden({ subject: 'Hi there' }))).toContain('empty_subject');
    expect(codes(golden({ subject: 'Congrats on the launch' }))).toContain('empty_subject');
  });

  it('flags a subject over 120 characters', () => {
    const long = `${SUBJECT} ${'and a great deal more detail than any inbox will ever show '.repeat(3)}`;
    expect(long.length).toBeGreaterThan(120);
    expect(codes(golden({ subject: long }))).toContain('subject_too_long');
  });
});

describe('lintCopy, forbidden phrases', () => {
  it('flags an offer in the text body', () => {
    const text = BODY_TEXT.replace(
      'This is the only email you will ever get from me. No follow-ups, no sequence.',
      'This is the only email you will ever get from me. No follow-ups, no sequence. Happy to walk you through it.',
    );
    const found = lintCopy(fromBody(BODY_HTML, text)).violations.filter((v) => v.code === 'forbidden_phrase');
    expect(found.length).toBeGreaterThan(0);
    expect(found[0].message).toContain('happy to');
  });

  it('flags a pitch smuggled into the subject', () => {
    expect(codes(golden({ subject: 'Your 502s, and a free trial while you fix them' }))).toContain('forbidden_phrase');
  });

  it('flags an offer in the html body only', () => {
    const html = BODY_HTML.replace('</body>', '<p>Book a call and we will look at it together.</p></body>');
    const found = lintCopy(fromBody(html, BODY_TEXT)).violations.filter((v) => v.code === 'forbidden_phrase');
    expect(found.map((v) => v.where)).toContain('html');
  });

  it('does not trip on the recipient\'s own signup flow, pricing page or a TLS upgrade', () => {
    const text = BODY_TEXT.replace(
      'The fix: the gateway',
      'Your signup flow returns the same 502, and your /pricing page 404s. Upgrade the gateway to TLS 1.3 while you are in there. The fix: the gateway',
    );
    const html = BODY_HTML.replace(
      '<p>The fix: the gateway',
      '<p>Your signup flow returns the same 502, and your /pricing page 404s. Upgrade the gateway to TLS 1.3 while you are in there. The fix: the gateway',
    );
    expect(codes(fromBody(html, text))).not.toContain('forbidden_phrase');
  });

  it('exports patterns that are all case insensitive and non global', () => {
    for (const { pattern, label } of FORBIDDEN_PATTERNS) {
      expect(pattern.flags, label).toContain('i');
      expect(pattern.flags, label).not.toContain('g');
    }
  });
});

describe('lintCopy, body rules', () => {
  it('flags a closing question', () => {
    const text = `${BODY_TEXT}\n\nWorth a look?`;
    const html = BODY_HTML.replace('</body>', '<p>Worth a look?</p></body>');
    expect(codes(fromBody(html, text))).toContain('closing_question');
  });

  it('flags a second product mention', () => {
    const text = BODY_TEXT.replace(
      'I run exit1.dev, an uptime monitor.',
      'I run exit1.dev, an uptime monitor. exit1.dev watches endpoints like this one all day.',
    );
    const html = BODY_HTML.replace(
      'I run exit1.dev, an uptime monitor.',
      'I run exit1.dev, an uptime monitor. exit1.dev watches endpoints like this one all day.',
    );
    const violation = lintCopy(fromBody(html, text)).violations.find((v) => v.code === 'product_mention_count');
    expect(violation?.message).toContain('appears 2 times');
  });

  it('flags zero product mentions', () => {
    const text = BODY_TEXT.replace('I run exit1.dev, an uptime monitor.', 'I run an uptime monitor.');
    const html = BODY_HTML.replace('I run exit1.dev, an uptime monitor.', 'I run an uptime monitor.');
    expect(codes(fromBody(html, text))).toContain('product_mention_count');
  });

  it('flags a missing provenance block', () => {
    const gone = 'I run exit1.dev, an uptime monitor. You launched on Hacker News this morning, so I pointed it at your site. I found your address on your /contact page.';
    const replacement = 'exit1.dev pointed its probe suite at your site this morning.';
    expect(codes(fromBody(BODY_HTML.replace(gone, replacement), BODY_TEXT.replace(gone, replacement)))).toContain(
      'missing_provenance',
    );
  });

  it('flags a provenance block that never says where the address came from', () => {
    const gone = ' I found your address on your /contact page.';
    expect(codes(fromBody(BODY_HTML.replace(gone, ''), BODY_TEXT.replace(gone, '')))).toContain('missing_provenance');
  });

  it('flags a body that never states the contact once policy', () => {
    const gone = 'This is the only email you will ever get from me. No follow-ups, no sequence.';
    const text = BODY_TEXT.replace(gone, 'That is the whole finding.');
    const html = BODY_HTML.replace(gone, 'That is the whole finding.');
    expect(codes(fromBody(html, text))).toContain('missing_contact_once');
  });

  it('flags html and text that do not tell the same story', () => {
    const text = [
      'Your certificate on api.example.com expires in nine days, on 2026-09-10.',
      '',
      'I run exit1.dev, an uptime monitor. I found your address on your /contact page.',
      '',
      'This is the only email you will ever get from me. No follow-ups, no sequence.',
      '',
      `Full log: ${CLICK}`,
    ].join('\n');
    expect(codes(fromBody(BODY_HTML, text))).toContain('html_text_divergence');
  });
});

describe('lintCopy, footer and links', () => {
  it('flags a missing footer element', () => {
    const input = golden();
    const stripped = {
      ...input,
      html: input.html.replace(POSTAL, ''),
      text: input.text.replace(POSTAL, ''),
    };
    expect(codes(stripped)).toContain('missing_footer_element');
  });

  it('flags a fourth link', () => {
    const rogue = 'https://exit1.dev/blog/why-502s-happen';
    const html = BODY_HTML.replace('</body>', `<p><a href="${rogue}">More on this</a></p></body>`);
    const text = `${BODY_TEXT}\n\nMore on this: ${rogue}`;
    const violation = lintCopy(fromBody(html, text)).violations.find((v) => v.code === 'link_not_permitted');
    expect(violation?.message).toContain(rogue);
  });

  it('flags a mailto that is not the sender or an unsubscribe mailbox', () => {
    const html = BODY_HTML.replace('</body>', '<p><a href="mailto:sales@exit1.dev">Talk to sales</a></p></body>');
    expect(codes(fromBody(html, BODY_TEXT))).toContain('link_not_permitted');
  });

  it('permits a mailto pointing at the sender', () => {
    const html = BODY_HTML.replace('</body>', `<p><a href="mailto:${FROM_EMAIL}">Reply</a></p></body>`);
    expect(codes(fromBody(html, BODY_TEXT))).not.toContain('link_not_permitted');
  });

  it('flags a missing permitted link', () => {
    const html = BODY_HTML.replace(`<a href="${CLICK}">${CLICK}</a>`, 'in the attached log');
    const text = BODY_TEXT.replace(CLICK, 'in the attached log');
    const violation = lintCopy(fromBody(html, text)).violations.find((v) => v.code === 'missing_permitted_link');
    expect(violation?.message).toContain('evidence link');
  });

  it('flags a one pixel tracking image', () => {
    const html = BODY_HTML.replace('</body>', `<img src="${BASE}/px.gif" width="1" height="1" alt=""></body>`);
    expect(codes(fromBody(html, BODY_TEXT))).toContain('tracking_pixel');
  });

  it('flags a remote image on a host that is not permitted', () => {
    const html = BODY_HTML.replace(
      '</body>',
      '<img src="https://track.example.net/open.png" width="600" height="80" alt="logo"></body>',
    );
    expect(codes(fromBody(html, BODY_TEXT))).toContain('tracking_pixel');
  });
});

describe('lintCopy, coverage', () => {
  it('has a case for every lint code', () => {
    const covered = new Set<LintCode>([
      'empty_subject',
      'subject_too_long',
      'forbidden_phrase',
      'closing_question',
      'product_mention_count',
      'missing_provenance',
      'missing_contact_once',
      'missing_footer_element',
      'link_not_permitted',
      'missing_permitted_link',
      'tracking_pixel',
      'html_text_divergence',
    ]);
    expect(covered.size).toBe(12);
  });
});
