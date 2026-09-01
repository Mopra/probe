'use server';

import { revalidatePath } from 'next/cache';
import { logger } from '@probe/config';
import { getCampaign, pauseAllCampaigns, setCampaignPaused, startWarmup } from '@probe/db';
import { getEnv } from './lib/probe';

const log = logger('web:actions');

/** The big red button (§5.5). Flips campaigns.paused = true for everything. */
export async function pauseEverything(): Promise<void> {
  const approver = safeApprover();
  const hit = await pauseAllCampaigns();
  log.warn('kill switch pulled', { approver, campaigns_paused: hit });
  revalidatePath('/');
  revalidatePath('/queue');
}

/** Per campaign pause and resume. Independent of PROBE_SEND_ENABLED. */
export async function setPaused(formData: FormData): Promise<void> {
  const id = String(formData.get('campaign_id') ?? '');
  const paused = String(formData.get('paused') ?? '') === 'true';
  if (!id) return;
  await setCampaignPaused(id, paused);
  log.info('campaign pause state changed', { campaign_id: id, paused, approver: safeApprover() });
  revalidatePath('/');
  revalidatePath('/queue');
}

/**
 * §5.4. Starts the warmup curve for one campaign, dated today in the campaign's
 * own timezone.
 *
 * Without a warmup_start, dailyCap() is 0 for every day, gate 4 of the send loop
 * reports cap_reached forever, and not one email leaves however many rows are
 * queued. There was no way to set it from anywhere: the runbook said to do it,
 * @probe/db could do it, and nothing called that function. This is the button.
 *
 * It deliberately does NOT unpause. Warmup and pausing are two independent gates
 * (§5.5) and one action must never close both.
 */
export async function startCampaignWarmup(formData: FormData): Promise<void> {
  const id = String(formData.get('campaign_id') ?? '');
  if (!id) return;

  const campaign = await getCampaign(id);
  if (!campaign) return;
  if (campaign.warmup_start) {
    // Re-dating warmup is the one edit here that can raise today's cap, so it
    // is not something a button does. `cli warmup <slug> <date> --yes` is.
    log.warn('warmup already started, ignoring', {
      campaign_id: id,
      warmup_start: String(campaign.warmup_start),
    });
    return;
  }

  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: campaign.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());

  await startWarmup(id, today);
  log.warn('warmup started', {
    campaign_id: id,
    slug: campaign.slug,
    day_one: today,
    approver: safeApprover(),
    still_paused: campaign.paused,
  });
  revalidatePath('/');
  revalidatePath('/queue');
}

function safeApprover(): string {
  try {
    return getEnv().PROBE_APPROVER;
  } catch {
    return 'unknown';
  }
}
