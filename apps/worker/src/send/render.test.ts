import { describe, expect, it } from 'vitest';
import { clickUrl, dataNoticeUrl, unsubscribeUrl } from '@probe/core';
import { renderSend } from './render';
import { buildFixtures } from '../harness/fixtures';

const BASE = 'https://probe.exit1.dev';
const POSTAL = 'Pradsgaard Labs, Testvej 1, 2100 Copenhagen, Denmark';
const UNSUB = 'unsub-token-aaa';
const CLICK = 'click-token-bbb';

function renderFixture(id: string) {
  const fixture = buildFixtures().find((f) => f.id === id);
  if (!fixture) throw new Error(`no fixture ${id}`);
  return {
    fixture,
    rendered: renderSend({
      proof: fixture.proof,
      lead: fixture.lead,
      campaign: fixture.campaign,
      contact: fixture.contact,
      unsubToken: UNSUB,
      clickToken: CLICK,
      baseUrl: BASE,
      postalAddress: POSTAL,
    }),
  };
}

describe('renderSend on the clean fixture', () => {
  const { fixture, rendered } = renderFixture('severity-1-clean');
  const evidence = fixture.proof.evidence_url as string;

  it('rewrites the evidence url through the click redirect', () => {
    expect(rendered.message.html).toContain(clickUrl(BASE, CLICK));
    expect(rendered.message.text).toContain(clickUrl(BASE, CLICK));
    // §8.7: the raw evidence url must not survive anywhere, or a click goes
    // unrecorded and the one signal short of a reply is lost.
    expect(rendered.message.html).not.toContain(evidence);
    expect(rendered.message.text).not.toContain(evidence);
  });

  it('appends the footer, with the postal address, unsubscribe and data notice', () => {
    for (const body of [rendered.message.html, rendered.message.text]) {
      expect(body).toContain(POSTAL);
      expect(body).toContain(unsubscribeUrl(BASE, UNSUB));
      expect(body).toContain(dataNoticeUrl(BASE));
      expect(body).toContain(fixture.campaign.from_name);
    }
  });

  it('carries the generator bytes through unaltered apart from those two steps', () => {
    // The finding itself is never touched. probe does not compose copy (§2).
    expect(rendered.message.text).toContain('Your /v1/usage endpoint returned 502');
    expect(rendered.message.subject).toBe(fixture.proof.subject);
  });

  it('passes the copy lint', () => {
    expect(rendered.lint.violations.map((v) => `${v.code}: ${v.message}`)).toEqual([]);
    expect(rendered.lint.ok).toBe(true);
  });

  it('builds a List-Unsubscribe one click mime', () => {
    expect(rendered.mime).toContain('List-Unsubscribe:');
    expect(rendered.mime).toContain('List-Unsubscribe-Post: List-Unsubscribe=One-Click');
    expect(rendered.mime).toContain('multipart/alternative');
  });
});

describe('the fixtures that break the lint on purpose', () => {
  it.each([
    ['trips-call-to-action', 'forbidden_phrase'],
    ['trips-second-product-mention', 'product_mention_count'],
    ['trips-fourth-link', 'link_not_permitted'],
  ])('%s trips %s', (id, code) => {
    const { rendered } = renderFixture(id);
    expect(rendered.lint.ok).toBe(false);
    expect(rendered.lint.violations.map((v) => v.code)).toContain(code);
  });
});
