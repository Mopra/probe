import { first, getSql, rows, withTx } from './client';
import type { CampaignRow } from './types';

export interface CampaignSeed {
  slug: string;
  product: string;
  generator_url: string;
  from_name: string;
  from_email: string;
  reply_to?: string;
  daily_cap: number;
  timezone: string;
  exclude_tags: string[];
  exclude_keywords: string[];
  routable: boolean;
}

/**
 * §11: probe.toml seeds, the database rules. Static fields are overwritten from
 * the file; `paused` and `warmup_start` are runtime state and are never touched
 * here. A seed that could unpause a campaign would make §3.1 rule 3 a
 * suggestion instead of an invariant.
 */
export async function seedCampaigns(campaigns: CampaignSeed[]): Promise<void> {
  if (campaigns.length === 0) return;

  await withTx(async (tx) => {
    for (const c of campaigns) {
      await tx`
        insert into campaigns (
          slug, product, generator_url, from_name, from_email, reply_to,
          daily_cap, timezone, exclude_tags, exclude_keywords, routable
        ) values (
          ${c.slug}, ${c.product}, ${c.generator_url}, ${c.from_name},
          ${c.from_email}, ${c.reply_to ?? null}, ${c.daily_cap}, ${c.timezone},
          ${tx.array(c.exclude_tags)}, ${tx.array(c.exclude_keywords)}, ${c.routable}
        )
        on conflict (slug) do update
          set product          = excluded.product,
              generator_url    = excluded.generator_url,
              from_name        = excluded.from_name,
              from_email       = excluded.from_email,
              reply_to         = excluded.reply_to,
              daily_cap        = excluded.daily_cap,
              timezone         = excluded.timezone,
              exclude_tags     = excluded.exclude_tags,
              exclude_keywords = excluded.exclude_keywords,
              routable         = excluded.routable
      `;
    }
  });
}

export async function listCampaigns(): Promise<CampaignRow[]> {
  const sql = getSql();
  return rows<CampaignRow>(await sql`select * from campaigns order by created_at, slug`);
}

export async function getCampaignBySlug(slug: string): Promise<CampaignRow | null> {
  const sql = getSql();
  return first<CampaignRow>(await sql`select * from campaigns where slug = ${slug}`);
}

export async function getCampaign(id: string): Promise<CampaignRow | null> {
  const sql = getSql();
  return first<CampaignRow>(await sql`select * from campaigns where id = ${id}`);
}

export async function setCampaignPaused(id: string, paused: boolean): Promise<void> {
  const sql = getSql();
  await sql`update campaigns set paused = ${paused} where id = ${id}`;
}

/** §5.5 big red button. Returns the number of campaigns actually flipped. */
export async function pauseAllCampaigns(): Promise<number> {
  const sql = getSql();
  const result = await sql`update campaigns set paused = true where paused = false`;
  return result.count;
}

/** `day` is 'YYYY-MM-DD'. Day 1 of the warmup curve is that date itself (§5.4). */
export async function startWarmup(id: string, day: string): Promise<void> {
  const sql = getSql();
  await sql`update campaigns set warmup_start = ${day}::date where id = ${id}`;
}
