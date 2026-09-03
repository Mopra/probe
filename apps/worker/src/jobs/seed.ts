// probe.toml seeds, the database rules (§11).
//
// Every [campaigns.*] block is upserted by slug on worker boot. Static fields
// come from the file; runtime-mutable state does not. That split is the whole
// point of the job: one source of truth per field, and no drift between a
// committed file and a table someone edited from the UI at 15:40.

import { loadConfig, logger } from '@probe/config';
import { seedCampaigns } from '@probe/db';

const log = logger('job.seed');

export interface SeedSummary {
  campaigns: number;
  slugs: string[];
}

/**
 * Upserts the campaigns from probe.toml.
 *
 * `paused` and `warmup_start` are absent from the payload on purpose and must
 * stay absent. Campaigns are born paused (§3.1 rule 3) and a deploy must never
 * unpause one: an operator who hit the big red button at 16:00 on Friday would
 * otherwise find the campaign sending again on Monday because someone shipped
 * an unrelated change. seedCampaigns is written to leave both columns alone,
 * and nothing here works around that, in particular by calling
 * setCampaignPaused(false) afterwards.
 *
 * Sources are not seeded here either. upsertSource belongs to the sweep job,
 * which owns the list of directories it can actually read.
 */
export async function runSeed(): Promise<SeedSummary> {
  const cfg = loadConfig();

  const payload = cfg.campaigns.map((c) => ({
    slug: c.slug,
    product: c.product,
    generator_url: c.generator_url,
    from_name: c.from_name,
    from_email: c.from_email,
    reply_to: c.reply_to,
    daily_cap: c.daily_cap,
    timezone: cfg.global.timezone,
    exclude_tags: c.exclude_tags,
    exclude_keywords: c.exclude_keywords,
    routable: c.routable,
  }));

  await seedCampaigns(payload);

  const slugs = payload.map((c) => c.slug);
  log.info('campaigns seeded from probe.toml', { count: slugs.length, slugs });
  return { campaigns: slugs.length, slugs };
}
