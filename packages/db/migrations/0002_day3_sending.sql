-- 0002_day3_sending: probe sends through the Day3 API, and the send claim
-- becomes atomic.
--
-- Two unrelated-looking changes ship together because they touch the same
-- index and splitting them would mean rebuilding it twice.
--
-- 1. THE ATOMIC CLAIM. `claimNextDueSend` used to SELECT ... FOR UPDATE SKIP
--    LOCKED inside a transaction that committed before the function returned,
--    which released the row lock while the row was still 'queued'. Nothing
--    changed its status until after the provider had accepted the message, so
--    two processes -- the daemon plus one `cli send`, or two daemons overlapping
--    across a systemd restart -- could both claim the same row and both send.
--    The partial unique index could not help: the row already existed.
--
--    The claim is now an UPDATE to 'sending', which is atomic by construction.
--    'sending' has to join the index's status list or the transition would
--    briefly free the contact-once slot and let a second lead take it
--    (§3.2: one email per person, ever).
--
-- 2. THE PROVIDER COLUMNS. probe no longer holds AWS credentials. Day3 owns
--    SES, so a send now has two ids: Day3's transactional email id
--    (`eml_...`), which is what probe holds immediately and what its webhooks
--    join on, and the SES message id, which arrives later on the first event.
--    `ses_message_id` keeps its name and its meaning; `provider_email_id` is
--    the new one.

alter table sends add column if not exists provider text;
alter table sends add column if not exists provider_email_id text;

-- The Day3 email id is how /hooks/day3 finds the send a webhook is about, and
-- it is the idempotency key probe sends, so it is unique per send.
create unique index if not exists sends_provider_email_id_uniq
  on sends (provider_email_id)
  where provider_email_id is not null;

-- §3.2, widened to hold the slot across the 'sending' window. Dropped and
-- recreated rather than altered: Postgres has no `alter index ... set where`.
-- Safe to re-run, and safe to run on a live table -- a send in flight during
-- the swap is protected by its row status, not by the index.
drop index if exists sends_email_hash_uniq;
create unique index if not exists sends_email_hash_uniq on sends (email_hash)
  where status in ('queued','sending','sent');

-- The pacing loop's claim reads (campaign_id, status, scheduled_for) and the
-- boot-time reconciliation reads status alone, both already served here.
drop index if exists sends_due_idx;
create index if not exists sends_due_idx on sends (campaign_id, status, scheduled_for);
