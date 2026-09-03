import { first, getSql, isUniqueViolation, rows, unsafeParams, withTx } from './client';
import {
  LIVE_SEND_STATUS_SQL,
  buildSendWhere,
  clampLimit,
  clampOffset,
  type SendFilter,
} from './filters';
import type { SendRow } from './types';

export type { SendFilter };

/**
 * §3.2. The database is the only thing enforcing contact-once, so this is the
 * only place that knows the policy exists, and it learns about a violation the
 * way it must: by being told no.
 */
export class ContactedAlreadyError extends Error {
  constructor(public readonly emailHash: string) {
    super(`address already has a live send (sends_email_hash_uniq): ${emailHash}`);
    this.name = 'ContactedAlreadyError';
  }
}

/**
 * Writes the approved send. A unique violation on sends_email_hash_uniq means
 * the address already has a queued or sent row, so the lead is a
 * `contacted_other_campaign` drop rather than an error.
 *
 * There is deliberately no pre-check here. Checking then inserting is exactly
 * the shape of bug the index exists to make impossible, and a caller that wants
 * an early signal has hasLiveSend for that, never as the only protection.
 */
export async function createSend(s: {
  proof_id: string;
  campaign_id: string;
  contact_id: string;
  email_hash: string;
  approved_by: string;
  scheduled_for: Date;
  unsub_token: string;
  click_token: string;
}): Promise<SendRow> {
  const sql = getSql();
  try {
    const result = await sql`
      insert into sends (
        proof_id, campaign_id, contact_id, email_hash,
        approved_by, approved_at, scheduled_for, unsub_token, click_token
      ) values (
        ${s.proof_id}::uuid, ${s.campaign_id}::uuid, ${s.contact_id}::uuid,
        ${s.email_hash}, ${s.approved_by}, now(), ${s.scheduled_for},
        ${s.unsub_token}, ${s.click_token}
      )
      returning *
    `;
    const row = first<SendRow>(result);
    if (!row) throw new Error('createSend returned no row');
    return row;
  } catch (err) {
    if (isUniqueViolation(err, 'sends_email_hash_uniq')) {
      throw new ContactedAlreadyError(s.email_hash);
    }
    throw err;
  }
}

/** Advisory only. sends_email_hash_uniq is what actually decides (§3.2). */
export async function hasLiveSend(emailHash: string): Promise<boolean> {
  const sql = getSql();
  const result = await sql.unsafe(
    `select 1 as hit from sends
      where email_hash = $1 and status in (${LIVE_SEND_STATUS_SQL})
      limit 1`,
    unsafeParams([emailHash]),
  );
  return result.length > 0;
}

export async function getSend(id: string): Promise<SendRow | null> {
  const sql = getSql();
  return first<SendRow>(await sql`select * from sends where id = ${id}::uuid`);
}

export async function getSendByUnsubToken(token: string): Promise<SendRow | null> {
  const sql = getSql();
  return first<SendRow>(await sql`select * from sends where unsub_token = ${token}`);
}

/**
 * The click redirect needs the destination in the same round trip, since
 * /c/:token must answer with a 302 and nothing else (§8.7).
 */
export async function getSendByClickToken(
  token: string,
): Promise<(SendRow & { evidence_url: string | null }) | null> {
  const sql = getSql();
  return first<SendRow & { evidence_url: string | null }>(await sql`
    select s.*, p.evidence_url
      from sends s
      join proofs p on p.id = s.proof_id
     where s.click_token = ${token}
  `);
}

export async function getSendBySesMessageId(id: string): Promise<SendRow | null> {
  const sql = getSql();
  return first<SendRow>(await sql`select * from sends where ses_message_id = ${id}`);
}

/**
 * §8.7. How /hooks/day3 resolves a webhook back to the send it is about. The
 * Day3 email id is the join key probe holds from the moment the message is
 * accepted, unlike the SES message id which only arrives with the first event.
 */
export async function getSendByProviderEmailId(id: string): Promise<SendRow | null> {
  const sql = getSql();
  return first<SendRow>(await sql`select * from sends where provider_email_id = ${id}`);
}

/**
 * §8.6. Claims the next due send for a campaign by MUTATING it, in one atomic
 * statement, and returns the claimed row.
 *
 * The claim has to be the mutation. An earlier version selected FOR UPDATE SKIP
 * LOCKED inside a transaction that committed before the function returned,
 * which released the row lock while the row was still 'queued' and left nothing
 * marking it as taken until the provider had already accepted the message. Two
 * processes -- the send daemon plus one `cli send`, or two daemons overlapping
 * across a systemd restart -- could therefore both claim the same row and both
 * send it. `sends_email_hash_uniq` cannot catch that: the row already exists,
 * so there is no second insert for it to reject. One email per person, ever
 * (§3.1) was resting on the fact that nobody had run two senders yet.
 *
 * FOR UPDATE SKIP LOCKED is still here, inside the subquery, and still earns
 * its place: it stops two concurrent claimants from queueing on the same row
 * and makes the loser pick the next one instead of waiting.
 *
 * 'sending' is in sends_email_hash_uniq's status list, so the claim never frees
 * the contact-once slot. A row left in 'sending' by a crashed worker is
 * recovered by reconcileStuckSends() on the next boot.
 */
export async function claimNextDueSend(
  campaignId: string,
  now: Date,
): Promise<SendRow | null> {
  const sql = getSql();
  const result = await sql`
    update sends
       set status = 'sending'
     where id = (
       select id from sends
        where campaign_id = ${campaignId}::uuid
          and status = 'queued'
          and scheduled_for <= ${now}
        order by scheduled_for
        limit 1
        for update skip locked
     )
    returning *
  `;
  return first<SendRow>(result);
}

/**
 * The same atomic claim, for one named row. `cli smoke` dispatches a specific
 * send immediately rather than waiting for the queue to reach it, and it must
 * claim that row the same way the daemon does: two processes racing the same
 * row is the failure `sends_email_hash_uniq` cannot catch, because the row
 * already exists and there is no second insert to reject.
 *
 * Null means the row was not 'queued' when this ran, so somebody else has it.
 */
export async function claimSend(id: string): Promise<SendRow | null> {
  const sql = getSql();
  const result = await sql`
    update sends
       set status = 'sending'
     where id = ${id}::uuid
       and status = 'queued'
    returning *
  `;
  return first<SendRow>(result);
}

/**
 * Puts a claimed row back in the queue without consuming anything. Used when a
 * gate after the claim says "not this one, not now" for a reason that is not
 * the send's fault: the kill switch flipped, the campaign was paused, the cap
 * was reached. Cancelling would burn the lead; failing would lie about why.
 */
export async function releaseSend(id: string): Promise<void> {
  const sql = getSql();
  await sql`
    update sends set status = 'queued' where id = ${id}::uuid and status = 'sending'
  `;
}

/**
 * Rows left in 'sending' by a process that died mid-dispatch. Ambiguous by
 * nature: the provider may or may not have accepted the message, and probe
 * cannot tell from here.
 *
 * They are returned rather than auto-resolved, because the two possible
 * repairs are opposites and only a human should choose. `olderThanMinutes`
 * exists so a live daemon's in-flight row is never reported as stuck.
 */
export async function stuckSendingSends(olderThanMinutes = 15): Promise<SendRow[]> {
  const sql = getSql();
  return rows<SendRow>(await sql`
    select * from sends
     where status = 'sending'
       and approved_at < now() - ${Math.max(1, Math.trunc(olderThanMinutes))}::int * interval '1 minute'
     order by scheduled_for
  `);
}

/**
 * Resolves stuck 'sending' rows to 'failed' so they stop holding a contact-once
 * slot and their proof returns to /queue for a deliberate re-approval.
 *
 * Called on worker boot. 'failed' rather than 'queued' on purpose: re-queueing
 * would re-send a message that may already have gone out, and a founder
 * receiving the same probe report twice is the mistake that would actually
 * embarrass us (§7). A human re-approving is the safe direction.
 */
export async function reconcileStuckSends(olderThanMinutes = 15): Promise<SendRow[]> {
  const sql = getSql();
  return rows<SendRow>(await sql`
    update sends
       set status = 'failed',
           error  = 'worker stopped mid-dispatch; whether the provider accepted this message is unknown'
     where status = 'sending'
       and approved_at < now() - ${Math.max(1, Math.trunc(olderThanMinutes))}::int * interval '1 minute'
    returning *
  `);
}

/**
 * Records the provider's acceptance. `providerEmailId` is Day3's transactional
 * email id, known immediately; `sesMessageId` is the underlying provider
 * message id, which Day3 relays later on the first delivery event, so it stays
 * null here.
 *
 * Guarded on 'sending': only the process that claimed the row may complete it.
 */
export async function markSendSent(
  id: string,
  p: { providerEmailId: string; provider?: string },
): Promise<boolean> {
  const sql = getSql();
  const result = await sql`
    update sends
       set status            = 'sent',
           sent_at           = now(),
           provider          = ${p.provider ?? 'day3'},
           provider_email_id = ${p.providerEmailId},
           error             = null
     where id = ${id}::uuid
       and status = 'sending'
    returning id
  `;
  return result.length > 0;
}

/** Fills in the SES message id when the first provider event carries it. */
export async function setSendProviderMessageId(
  id: string,
  sesMessageId: string,
): Promise<void> {
  const sql = getSql();
  await sql`
    update sends
       set ses_message_id = ${sesMessageId}
     where id = ${id}::uuid and ses_message_id is null
  `;
}

/**
 * A failed send releases its slot in sends_email_hash_uniq (the index is
 * partial on 'queued', 'sending' and 'sent'), so a transient provider error
 * cannot burn a contact forever.
 */
export async function markSendFailed(id: string, error: string): Promise<void> {
  const sql = getSql();
  await sql`update sends set status = 'failed', error = ${error} where id = ${id}::uuid`;
}

export async function cancelSend(id: string, reason: string): Promise<void> {
  const sql = getSql();
  await sql`
    update sends set status = 'cancelled', error = ${reason} where id = ${id}::uuid
  `;
}

/** Today in the campaign's own timezone, which is what the daily cap counts. */
export async function sentTodayCount(
  campaignId: string,
  timezone: string,
  now: Date,
): Promise<number> {
  const sql = getSql();
  const result = await sql`
    select count(*)::int as n
      from sends
     where campaign_id = ${campaignId}::uuid
       and status = 'sent'
       and sent_at is not null
       and (sent_at at time zone ${timezone})::date
         = (${now}::timestamptz at time zone ${timezone})::date
  `;
  return first<{ n: number }>(result)?.n ?? 0;
}

export type SendListItem = SendRow & {
  campaign_slug: string;
  lead_name: string;
  lead_id: string;
  subject: string | null;
  contact_email: string | null;
};

export async function listSends(f: SendFilter): Promise<SendListItem[]> {
  const sql = getSql();
  const where = buildSendWhere(f);
  const limit = clampLimit(f.limit, 100, 1000);
  const offset = clampOffset(f.offset);
  const n = where.params.length;

  const text = `
    select s.*,
           c.slug    as campaign_slug,
           l.name    as lead_name,
           l.id      as lead_id,
           p.subject as subject,
           ct.email  as contact_email
      from sends s
      join campaigns c on c.id = s.campaign_id
      join proofs p    on p.id = s.proof_id
      join leads l     on l.id = p.lead_id
      join contacts ct on ct.id = s.contact_id
      ${where.text}
     order by coalesce(s.sent_at, s.scheduled_for) desc
     limit $${n + 1} offset $${n + 2}`;

  return rows<SendListItem>(
    await sql.unsafe(text, unsafeParams([...where.params, limit, offset])),
  );
}
