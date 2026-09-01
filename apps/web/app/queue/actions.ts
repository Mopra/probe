'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { logger } from '@probe/config';
import { newToken } from '@probe/core';
import {
  ContactedAlreadyError,
  createSend,
  dropLead,
  getQueueItem,
  isSuppressed,
  setLeadStatus,
} from '@probe/db';
import { getConfig, getEnv } from '../lib/probe';
import { renderProof } from '../lib/render';
import { planSlot } from '../lib/schedule';

const log = logger('web:queue');

function back(notice: string, detail?: string): never {
  const params = new URLSearchParams({ notice });
  if (detail) params.set('detail', detail);
  redirect(`/queue?${params.toString()}`);
}

/**
 * Approve (§8.5). In order, and every step can refuse:
 *   1. the proof must still be in the queue
 *   2. the lint must pass, re-run here rather than trusted from the page (§9.2.8)
 *   3. the address must not have been suppressed since the proof was built
 *   4. sends_email_hash_uniq decides contact-once, not this code (§3.2)
 */
export async function approveProof(formData: FormData): Promise<void> {
  const proofId = String(formData.get('proof_id') ?? '');
  if (!proofId) back('missing');

  const item = await getQueueItem(proofId);
  if (!item || item.proof.status !== 'ready') back('missing');

  const rendered = renderProof(item);
  if (!rendered.lint.ok) {
    log.warn('approval refused by copy lint', {
      proof_id: proofId,
      lead: item.lead.domain,
      violations: rendered.lint.violations.map((v) => v.code),
    });
    back('lint_failed', String(rendered.lint.violations.length));
  }

  if (await isSuppressed(item.contact.email_hash)) {
    await dropLead(item.lead.id, 'suppressed');
    log.warn('approval refused, address suppressed since generation', {
      proof_id: proofId,
      lead: item.lead.domain,
    });
    revalidatePath('/queue');
    revalidatePath('/');
    back('suppressed', item.lead.name);
  }

  const config = getConfig();
  const env = getEnv();
  const now = new Date();
  const plan = await planSlot({ campaign: item.campaign, now, global: config.global });

  try {
    await createSend({
      proof_id: item.proof.id,
      campaign_id: item.campaign.id,
      contact_id: item.contact.id,
      email_hash: item.contact.email_hash,
      approved_by: env.PROBE_APPROVER,
      scheduled_for: plan.scheduledFor,
      unsub_token: newToken(),
      click_token: newToken(),
    });
  } catch (err) {
    if (err instanceof ContactedAlreadyError) {
      // §3.2 is enforced by the index, so this is the expected path, not a 500.
      await dropLead(item.lead.id, 'contacted_other_campaign');
      log.info('lead dropped, address already carries a live send', {
        proof_id: proofId,
        lead: item.lead.domain,
      });
      revalidatePath('/queue');
      revalidatePath('/');
      revalidatePath('/leads');
      back('contacted', item.lead.name);
    }
    throw err;
  }

  await setLeadStatus(item.lead.id, 'approved', item.campaign.id);

  log.info('proof approved', {
    proof_id: proofId,
    lead: item.lead.domain,
    campaign: item.campaign.slug,
    scheduled_for: plan.scheduledFor.toISOString(),
    approved_by: env.PROBE_APPROVER,
  });

  revalidatePath('/queue');
  revalidatePath('/');
  revalidatePath('/sends');
  revalidatePath('/leads');
  back(plan.overCapacity ? 'approved_no_capacity' : 'approved', plan.scheduledFor.toISOString());
}

/** Reject. The lead stops here; drop_reason stays untouched (§8.2). */
export async function rejectProof(formData: FormData): Promise<void> {
  const proofId = String(formData.get('proof_id') ?? '');
  if (!proofId) back('missing');

  const item = await getQueueItem(proofId);
  if (!item) back('missing');

  await setLeadStatus(item.lead.id, 'rejected');
  log.info('proof rejected', { proof_id: proofId, lead: item.lead.domain });

  revalidatePath('/queue');
  revalidatePath('/');
  revalidatePath('/leads');
  back('rejected', item.lead.name);
}
