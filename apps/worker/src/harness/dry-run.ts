// The dry-run harness (§13 M0).
//
// The thing Morten lives in for two weeks. It composes real outbound bytes,
// writes them to ./outbox as .eml, and prints the copy lint verdict for each
// one. It must work with no database and no network, because that is what
// makes it useful on day one and what lets generator output be iterated on for
// a fortnight without a single real send.
//
// Printing to the operator IS the output here, so console is the interface.

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { LintViolation } from '@probe/core';
import { newToken } from '@probe/core';
import type { CampaignRow, ContactRow, LeadRow, ProofRow } from '@probe/db';
import { renderSend } from '../send/render';
import { baseUrl as defaultBaseUrl, outboxDir, postalAddress as defaultPostal } from '../send/runtime';
import { buildFixtures } from './fixtures';

export interface DryRunOptions {
  /** Render every proof currently ready, from the database, instead of the
   *  built-in fixtures. Needs SUPABASE_DB_URL; the default mode does not. */
  fromDb?: boolean;
  outDir?: string;
  limit?: number;
  baseUrl?: string;
  postalAddress?: string;
  /** Silences the printing, for tests. */
  quiet?: boolean;
}

export interface DryRunItem {
  id: string;
  label: string;
  subject: string;
  to: string;
  file: string;
  bytes: number;
  ok: boolean;
  /** False for the fixtures that break the lint on purpose. Database proofs
   *  are all expected to pass: a ready proof that fails the lint is a bug. */
  expectedPass: boolean;
  violations: LintViolation[];
}

export interface DryRunResult {
  mode: 'fixtures' | 'database';
  outDir: string;
  items: DryRunItem[];
  written: number;
  passed: number;
  failed: number;
  /** Lint failures that were not expected. Non-zero means exit non-zero, which
   *  is what makes this usable in CI as a regression test on the lint and the
   *  footer. */
  unexpected: number;
}

export async function runDryRun(opts: DryRunOptions = {}): Promise<DryRunResult> {
  const outDir = opts.outDir ?? outboxDir();
  const base = opts.baseUrl ?? defaultBaseUrl();
  const postal = opts.postalAddress ?? defaultPostal();
  const say = opts.quiet ? () => undefined : (line: string) => console.log(line);

  await fs.mkdir(outDir, { recursive: true });

  const mode: DryRunResult['mode'] = opts.fromDb ? 'database' : 'fixtures';
  say('');
  say(`probe dry run  mode=${mode}  outbox=${path.resolve(outDir)}`);
  say(`base=${base}`);
  say('');

  const items: DryRunItem[] = [];
  const sources = opts.fromDb ? await databaseSources(opts.limit) : fixtureSources();

  for (const source of sources) {
    const rendered = renderSend({
      proof: source.proof,
      lead: source.lead,
      campaign: source.campaign,
      contact: source.contact,
      // Throwaway tokens. Nothing is queued, so nothing owns a real one, and
      // the lint only needs a well formed set of three links.
      unsubToken: newToken(),
      clickToken: newToken(),
      baseUrl: base,
      postalAddress: postal,
    });

    const file = path.join(outDir, `${safeName(source.id)}.eml`);
    await fs.writeFile(file, rendered.mime, 'utf8');

    const item: DryRunItem = {
      id: source.id,
      label: source.label,
      subject: rendered.message.subject,
      to: rendered.message.to,
      file,
      bytes: Buffer.byteLength(rendered.mime, 'utf8'),
      ok: rendered.lint.ok,
      expectedPass: source.expectLintPass,
      violations: rendered.lint.violations,
    };
    items.push(item);

    print(say, item, source.note);
  }

  const passed = items.filter((i) => i.ok).length;
  const failed = items.length - passed;
  const unexpected = items.filter((i) => i.expectedPass && !i.ok).length;
  const surprisePasses = items.filter((i) => !i.expectedPass && i.ok);

  say('');
  say(
    `${items.length} written  ${passed} lint ok  ${failed} lint failed  ` +
      `${unexpected} unexpected failure${unexpected === 1 ? '' : 's'}`,
  );
  for (const item of surprisePasses) {
    // A fixture written to break the lint that now passes means the lint got
    // weaker, which is exactly as interesting as a regression.
    say(`  warning: ${item.id} was expected to fail the lint and passed`);
  }
  say('');

  return { mode, outDir, items, written: items.length, passed, failed, unexpected };
}

interface RenderSource {
  id: string;
  label: string;
  note: string;
  expectLintPass: boolean;
  proof: ProofRow;
  lead: LeadRow;
  campaign: CampaignRow;
  contact: ContactRow;
}

function fixtureSources(): RenderSource[] {
  return buildFixtures().map((f) => ({
    id: f.id,
    label: f.label,
    note: f.note,
    expectLintPass: f.expectLintPass,
    proof: f.proof,
    lead: f.lead,
    campaign: f.campaign,
    contact: f.contact,
  }));
}

/** Imported lazily so the default mode never loads the database package at
 *  all, let alone opens a connection. */
async function databaseSources(limit?: number): Promise<RenderSource[]> {
  const db = await import('@probe/db');
  const queue = await db.listQueue(limit ?? 100);
  return queue.map((item) => ({
    id: `${item.campaign.slug}-${item.lead.domain}-${item.proof.id.slice(0, 8)}`,
    label: `${item.lead.name} (${item.campaign.slug})`,
    note: `lead ${item.lead.id}`,
    expectLintPass: true,
    proof: item.proof,
    lead: item.lead,
    campaign: item.campaign,
    contact: item.contact,
  }));
}

function print(say: (line: string) => void, item: DryRunItem, note: string): void {
  const verdict = item.ok ? 'LINT OK  ' : 'LINT FAIL';
  const flag = item.expectedPass === item.ok ? ' ' : '!';
  say(`${flag} ${verdict}  ${item.id}`);
  say(`             ${item.label}`);
  say(`             ${note}`);
  say(`             subject: ${item.subject}`);
  say(`             to: ${item.to || '(no address)'}  ${item.bytes} bytes`);
  say(`             file: ${item.file}`);
  for (const v of item.violations) {
    say(`             - ${v.code} [${v.where}] ${v.message}`);
  }
  say('');
}

function safeName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 80) || 'proof';
}
