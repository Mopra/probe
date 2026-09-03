// Sweep, 06:30 daily (§8.1).
//
// Two rules carry this job. Failures are isolated: one broken scraper does
// not stop the rest, so every source runs inside its own try/catch and its
// error lands on the source row for /health rather than in the process exit
// code. And every lead is stored, always: jurisdiction, matching and
// suppression decide what probe does with a lead, never whether it is
// recorded. The swept list, including the founders who will never be
// contacted, is an asset in its own right.

import { logger } from '@probe/config';
import { isPlatformDomain, normalizeDomain, normalizeUrl } from '@probe/core';
import { insertLead, markSweepError, markSweepOk, upsertSource } from '@probe/db';
import { SOURCES } from '../sources';
import type { RawLead, SweepSummary } from '../types';

const log = logger('job.sweep');

interface SourceOutcome {
  swept: number;
  inserted: number;
  duplicates: number;
  unusable: number;
}

async function storeLeads(sourceId: string, raw: RawLead[]): Promise<SourceOutcome> {
  const outcome: SourceOutcome = { swept: raw.length, inserted: 0, duplicates: 0, unusable: 0 };

  for (const lead of raw) {
    const url = normalizeUrl(lead.url);
    const domain = url ? normalizeDomain(url) : null;
    if (!url || !domain) {
      // No usable domain means no surface to probe and nothing for
      // leads_domain_uniq to key on. Counted so a source that starts
      // returning junk is visible rather than quietly thinner.
      outcome.unusable += 1;
      log.debug('lead has no usable domain', { source: sourceId, external_id: lead.external_id, url: lead.url });
      continue;
    }

    // A repository, a profile, a hosted demo. The product behind the link may
    // be real, but the domain is GitHub's or Vercel's, so the contact cascade
    // would find their address and the generator would report on their
    // infrastructure. Dropped here rather than later: there is no version of
    // this lead worth resolving, and the jurisdiction gate used to hide the
    // problem by blocking these as unknown.
    if (isPlatformDomain(domain)) {
      outcome.unusable += 1;
      log.debug('lead is a platform domain, not a product', {
        source: sourceId,
        external_id: lead.external_id,
        domain,
      });
      continue;
    }

    const row = await insertLead({
      source_id: sourceId,
      external_id: lead.external_id,
      name: lead.name,
      url,
      domain,
      description: lead.description,
      tags: lead.tags,
      launched_at: lead.launched_at,
    });

    // insertLead returns null for both unique conflicts: the same post seen
    // twice, and the same product launched on a second directory (§7).
    if (row) outcome.inserted += 1;
    else outcome.duplicates += 1;
  }

  return outcome;
}

export async function runSweep(): Promise<SweepSummary> {
  const summary: SweepSummary = { swept: 0, inserted: 0, duplicates: 0, errors: [] };
  let unusable = 0;

  // The table always matches the code, disabled sources included, so /health
  // lists the nine directories that are not built yet (§8.1).
  for (const source of SOURCES) {
    await upsertSource({
      id: source.id,
      name: source.name,
      kind: source.kind,
      enabled: source.enabled,
    });
  }

  for (const source of SOURCES) {
    if (!source.enabled) {
      log.debug('source disabled, skipping', { source: source.id });
      continue;
    }

    try {
      const raw = await source.sweep();
      const outcome = await storeLeads(source.id, raw);
      summary.swept += outcome.swept;
      summary.inserted += outcome.inserted;
      summary.duplicates += outcome.duplicates;
      unusable += outcome.unusable;
      await markSweepOk(source.id);
      log.info('source swept', {
        source: source.id,
        swept: outcome.swept,
        inserted: outcome.inserted,
        duplicates: outcome.duplicates,
        unusable: outcome.unusable,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      summary.errors.push({ source: source.id, error: message });
      await markSweepError(source.id, message);
      log.error('source failed', { source: source.id, error: message });
    }
  }

  log.info('sweep complete', {
    swept: summary.swept,
    inserted: summary.inserted,
    duplicates: summary.duplicates,
    unusable,
    errors: summary.errors.length,
  });

  return summary;
}
