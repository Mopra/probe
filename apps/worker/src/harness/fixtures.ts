// Built-in proofs for the dry-run harness (§13 M0).
//
// These stand in for generator output so the harness works with no database
// and no network on day one. One of them is what a good severity-1 exit1
// finding looks like; the other three each break the copy lint in one specific
// way, so the harness doubles as a regression test on the lint and the footer.
//
// The copy here is the reference for what §9.2 actually reads like. If a
// generator's output does not look like fixture one, the generator is wrong.

import type { CampaignRow, ContactRow, LeadRow, ProofRow } from '@probe/db';

export interface Fixture {
  id: string;
  label: string;
  /** What this fixture is here to demonstrate. Printed by the harness. */
  note: string;
  /** False for the three that break the lint on purpose. The harness exits
   *  non-zero only when a fixture that should pass does not. */
  expectLintPass: boolean;
  proof: ProofRow;
  lead: LeadRow;
  campaign: CampaignRow;
  contact: ContactRow;
}

const EVIDENCE_URL = 'https://exit1.dev/probe/01JQ7Z8R5K2M4N6P8Q0S2T4V6X';
const LAUNCHED_AT = new Date('2026-09-01T06:00:00Z');

// --- the pieces every fixture shares ---------------------------------------

const FINDING_TEXT =
  'Your /v1/usage endpoint returned 502 on 3 of 20 requests between 06:14 and ' +
  '07:49 UTC this morning. All three failures came from probes that sent no ' +
  'Accept header. The seventeen that set Accept: application/json returned 200 ' +
  'every time.';

const EVIDENCE_LABEL = 'Full log, with request ids, response headers and timings';

const FIX_TEXT =
  'The fix: your gateway falls back to a default route when Accept is absent, ' +
  'and that route has no handler for /v1/usage. Setting a default of ' +
  'application/json at the gateway, or returning an explicit 406 for ' +
  'unsupported media types, removes the 502 and the ambiguity behind it.';

// §9.2.4. First person, names the product once, says where the address came
// from. This sentence is also the GDPR Article 14 notice.
const PROVENANCE_TEXT =
  'I run exit1.dev, an uptime monitor. You launched on Hacker News this ' +
  'morning, so I pointed it at your public surface for ninety minutes. I found ' +
  'your address on your /contact page. Where your data lives and how to have it ' +
  'deleted is linked at the bottom of this email.';

// §9.2.6. The policy stated in the body, not only in the footer probe controls.
const CONTACT_ONCE_TEXT =
  'This is the only email you will ever get from me. No follow-ups, no sequence.';

const SUBJECT = '/v1/usage returned 502 on 3 of 20 probes this morning';

/** Body paragraphs as plain text. A paragraph that is an object is a link. */
type Para = string | { label: string; url: string };

function textBody(paras: Para[]): string {
  return paras
    .map((p) => (typeof p === 'string' ? p : `${p.label}: ${p.url}`))
    .join('\n\n');
}

function htmlBody(paras: Para[]): string {
  const style = 'margin:0 0 16px;line-height:1.6;';
  const body = paras
    .map((p) =>
      typeof p === 'string'
        ? `<p style="${style}">${p}</p>`
        : `<p style="${style}"><a href="${p.url}">${p.label}</a></p>`,
    )
    .join('\n    ');
  return [
    '<html>',
    '  <body style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif;font-size:15px;color:#1a1a1a;">',
    `    ${body}`,
    '  </body>',
    '</html>',
  ].join('\n');
}

// --- row factories ----------------------------------------------------------

export function fixtureCampaign(over: Partial<CampaignRow> = {}): CampaignRow {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    slug: 'exit1',
    product: 'exit1.dev',
    generator_url: 'https://exit1.dev/api/probe/generate',
    from_name: 'Morten Pradsgaard',
    from_email: 'morten@mail.exit1.dev',
    reply_to: 'morten@mail.exit1.dev',
    paused: true,
    routable: true,
    warmup_start: null,
    daily_cap: 50,
    timezone: 'Europe/Copenhagen',
    exclude_tags: ['monitoring', 'observability', 'uptime', 'status-page', 'apm'],
    exclude_keywords: [],
    created_at: LAUNCHED_AT,
    ...over,
  };
}

export function fixtureLead(over: Partial<LeadRow> = {}): LeadRow {
  return {
    id: '00000000-0000-4000-8000-000000000010',
    source_id: 'show_hn',
    external_id: '41234567',
    name: 'Meterbase',
    url: 'https://meterbase.dev',
    domain: 'meterbase.dev',
    description: 'Usage-based billing for API companies',
    tags: ['api', 'billing', 'developer-tools'],
    launched_at: LAUNCHED_AT,
    discovered_at: LAUNCHED_AT,
    jurisdiction: 'US',
    jurisdiction_source: 'hn_profile',
    jurisdiction_detail: 'San Francisco, CA',
    status: 'ready',
    campaign_id: '00000000-0000-4000-8000-000000000001',
    drop_reason: null,
    notes: null,
    ...over,
  };
}

export function fixtureContact(over: Partial<ContactRow> = {}): ContactRow {
  return {
    id: '00000000-0000-4000-8000-000000000020',
    lead_id: '00000000-0000-4000-8000-000000000010',
    email: 'priya@meterbase.dev',
    email_norm: 'priya@meterbase.dev',
    email_hash: 'fixture-hash-not-a-real-peppered-hash',
    first_name: 'Priya',
    method: 'mailto',
    confidence: 90,
    found_at: LAUNCHED_AT,
    ...over,
  };
}

export function fixtureProof(over: Partial<ProofRow> = {}): ProofRow {
  return {
    id: '00000000-0000-4000-8000-000000000030',
    lead_id: '00000000-0000-4000-8000-000000000010',
    campaign_id: '00000000-0000-4000-8000-000000000001',
    subject: SUBJECT,
    html: '',
    text_body: '',
    fix: FIX_TEXT,
    severity: 1,
    evidence_url: EVIDENCE_URL,
    meta: { probes: 20, failures: 3, window: '06:14-07:49' },
    attempts: 1,
    polls: 3,
    status: 'ready',
    error: null,
    created_at: LAUNCHED_AT,
    ready_at: LAUNCHED_AT,
    first_requested_at: LAUNCHED_AT,
    next_poll_at: null,
    ...over,
  };
}

let fixtureCounter = 0;

function fixtureFrom(args: {
  id: string;
  label: string;
  note: string;
  expectLintPass: boolean;
  paras: Para[];
  subject?: string;
}): Fixture {
  fixtureCounter += 1;
  return {
    id: args.id,
    label: args.label,
    note: args.note,
    expectLintPass: args.expectLintPass,
    campaign: fixtureCampaign(),
    lead: fixtureLead(),
    contact: fixtureContact(),
    proof: fixtureProof({
      id: `00000000-0000-4000-8000-0000000003${String(fixtureCounter).padStart(2, '0')}`,
      subject: args.subject ?? SUBJECT,
      html: htmlBody(args.paras),
      text_body: textBody(args.paras),
    }),
  };
}

// --- the fixtures -----------------------------------------------------------

const CLEAN_PARAS: Para[] = [
  FINDING_TEXT,
  { label: EVIDENCE_LABEL, url: EVIDENCE_URL },
  FIX_TEXT,
  PROVENANCE_TEXT,
  CONTACT_ONCE_TEXT,
];

export function buildFixtures(): Fixture[] {
  return [
    fixtureFrom({
      id: 'severity-1-clean',
      label: 'severity 1, exit1, passes the lint',
      note:
        'What a mailable finding looks like: the finding is the subject and the ' +
        'first sentence, the fix is in the body, provenance names the product ' +
        'exactly once, and the only link in the body is the evidence page.',
      expectLintPass: true,
      paras: CLEAN_PARAS,
    }),

    fixtureFrom({
      id: 'severity-1-quotes-their-url',
      label: 'severity 1, quotes the recipient own url, passes the lint',
      note:
        'The shape the real exit1 generator produces for a broken-link or ' +
        'error-status finding. It quotes a url on the RECIPIENT domain, which is ' +
        'the evidence rather than a fourth funnel, so §9.2.5 permits it. Four of ' +
        'the generator five finding kinds look like this, and all four were ' +
        'being dropped as generator_failed until the lint learned the difference.',
      expectLintPass: true,
      subject: '/status is linked from your launch page and returns 404',
      paras: [
        'Your landing page links to https://meterbase.dev/status, which returned HTTP 404.',
        'Two links on https://meterbase.dev/ point at pages on your own domain that do not ' +
          'resolve: /status (404) and /docs/api (404).',
        'These are usually pages that were renamed or never shipped, with the nav still ' +
          'pointing at the old path. The full list with status codes is in the report below.',
        { label: EVIDENCE_LABEL, url: EVIDENCE_URL },
        PROVENANCE_TEXT,
        CONTACT_ONCE_TEXT,
      ],
    }),

    fixtureFrom({
      id: 'trips-third-party-link',
      label: 'trips the lint: a link on somebody else domain',
      note:
        'The counterpart to the fixture above. A url on the recipient own domain ' +
        'is evidence; a url anywhere else is still a fourth link, whoever owns ' +
        'it. This is what keeps the relaxation from becoming a loophole.',
      expectLintPass: false,
      paras: [
        'Your landing page links to https://meterbase.dev/status, which returned HTTP 404.',
        FIX_TEXT,
        { label: EVIDENCE_LABEL, url: EVIDENCE_URL },
        { label: 'A writeup of how we check this', url: 'https://exit1.dev/blog/broken-links' },
        PROVENANCE_TEXT,
        CONTACT_ONCE_TEXT,
      ],
    }),

    fixtureFrom({
      id: 'trips-call-to-action',
      label: 'trips the lint: a call to action',
      note:
        'A generator that drifted salesy. §9.2.5 is zero asks, and the lint is ' +
        'what notices before Morten does.',
      expectLintPass: false,
      paras: [
        FINDING_TEXT,
        { label: EVIDENCE_LABEL, url: EVIDENCE_URL },
        FIX_TEXT,
        PROVENANCE_TEXT,
        'Happy to jump on a call this week and walk through the rest of the run. ' +
          'There is a free trial if you want to point it at your own endpoints.',
        CONTACT_ONCE_TEXT,
      ],
    }),

    fixtureFrom({
      id: 'trips-second-product-mention',
      label: 'trips the lint: a second product mention',
      note:
        'One mention is provenance. Two is a pitch wearing provenance as a hat, ' +
        'which is exactly the drift §9.2.8 exists to catch.',
      expectLintPass: false,
      paras: [
        FINDING_TEXT,
        { label: EVIDENCE_LABEL, url: EVIDENCE_URL },
        FIX_TEXT,
        PROVENANCE_TEXT,
        'exit1.dev runs these probes from four regions on a one minute interval, ' +
          'which is how the intermittent failures showed up at all.',
        CONTACT_ONCE_TEXT,
      ],
    }),

    fixtureFrom({
      id: 'trips-fourth-link',
      label: 'trips the lint: a fourth link',
      note:
        'Exactly three links are permitted: evidence, unsubscribe, data notice. ' +
        'A fourth one is a funnel, whatever it points at.',
      expectLintPass: false,
      paras: [
        FINDING_TEXT,
        { label: EVIDENCE_LABEL, url: EVIDENCE_URL },
        FIX_TEXT,
        {
          label: 'Background on how these probes are run',
          url: 'https://exit1.dev/how-it-works',
        },
        PROVENANCE_TEXT,
        CONTACT_ONCE_TEXT,
      ],
    }),
  ];
}
