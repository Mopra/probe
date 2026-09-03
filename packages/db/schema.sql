-- probe schema, complete and current. PLAN.md §7 plus the additive columns
-- listed in docs/CONTRACTS.md. Applying this file to an empty database gives
-- exactly what migrations/0001_init.sql gives.
--
-- Everything here is written to be safe to re-run: `if not exists` where
-- Postgres supports it, `do $$ ... $$` guards for the enum types where it does
-- not.

-- gen_random_uuid() lives in pgcrypto on Postgres versions before 13 and is
-- built in after; requesting the extension is harmless either way.
create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Migration bookkeeping
-- ---------------------------------------------------------------------------

create table if not exists _migrations (
  id          text primary key,
  applied_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Types
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_type where typname = 'lead_status') then
    create type lead_status as enum (
      'discovered','contact_resolved','no_contact','matched','no_match',
      'generating','ready','approved','sent','rejected','no_proof','dropped'
    );
  end if;
end
$$;

-- Note: no 'sent' reason. Sends never insert suppressions; the contact-once
-- policy (§3.2) lives entirely in sends_email_hash_uniq below, so relaxing
-- that index is a real lever and not a no-op.
do $$
begin
  if not exists (select 1 from pg_type where typname = 'suppression_reason') then
    create type suppression_reason as enum (
      'unsubscribed','complained','bounced','replied','manual'
    );
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

-- Launch directories we sweep
create table if not exists sources (
  id            text primary key,          -- 'show_hn', 'product_hunt', …
  name          text not null,
  kind          text not null,             -- 'api' | 'rss' | 'scrape'
  enabled       boolean not null default true,
  last_swept_at timestamptz,
  last_error    text
);

create table if not exists campaigns (
  id            uuid primary key default gen_random_uuid(),
  slug          text unique not null,       -- 'exit1', 'day3'
  product       text not null,
  generator_url text not null,
  from_name     text not null,              -- 'Morten Pradsgaard'
  from_email    text not null,              -- 'morten@mail.exit1.dev'
  reply_to      text,
  paused        boolean not null default true,
  -- Whether matching may route leads here at all. Distinct from `paused`, which
  -- gates sending only: a paused campaign still collects leads in its queue,
  -- and a campaign whose generator does not exist yet must collect none.
  routable      boolean not null default true,
  warmup_start  date,
  daily_cap     int not null default 50,
  timezone      text not null default 'Europe/Copenhagen',
  -- Matching reads the table, never probe.toml (§11): the file seeds these,
  -- and everything at runtime has exactly one source of truth.
  exclude_tags     text[] not null default '{}',
  exclude_keywords text[] not null default '{}',
  created_at    timestamptz not null default now()
);

-- A product that launched
create table if not exists leads (
  id            uuid primary key default gen_random_uuid(),
  source_id     text not null references sources(id),
  external_id   text not null,             -- id within that source
  name          text not null,
  url           text not null,
  domain        text not null,             -- normalised, for dedup
  description   text,
  tags          text[] not null default '{}',
  launched_at   timestamptz,
  discovered_at timestamptz not null default now(),
  jurisdiction  text,                      -- ISO 3166-1 alpha-2; null = unknown
  jurisdiction_source text,                -- 'tld' | 'imprint' | 'hn_profile' | …
  jurisdiction_detail text,                -- raw signal behind the guess
  status        lead_status not null default 'discovered',
  campaign_id   uuid references campaigns(id),
  drop_reason   text,                      -- see §8.2; never overwrite once set
  notes         text,
  unique (source_id, external_id)
);
-- §8.2 drop accounting: /health reads the breakdown by reason over a date
-- range, so the reason leads the index and discovered_at follows it.
create index if not exists leads_drop_reason_idx on leads (drop_reason, discovered_at);

-- Same product on three directories is one lead
create unique index if not exists leads_domain_uniq on leads (domain);

-- Every pipeline job selects the next batch by status, and /leads filters on it.
create index if not exists leads_status_idx on leads (status);

-- Lookups by domain are already served by leads_domain_uniq, which is a real
-- index and not just a constraint. A second index on the same column would only
-- add write cost, so there deliberately is not one.

-- Jurisdiction share on /health (§15.6) counts by country over all swept leads.
create index if not exists leads_jurisdiction_idx on leads (jurisdiction);

create table if not exists contacts (
  id           uuid primary key default gen_random_uuid(),
  lead_id      uuid not null references leads(id) on delete cascade,
  email        text,                       -- nulled on suppression, see §9
  email_norm   text,                       -- lowercased, +tag stripped; nulled with email
  email_hash   text not null,              -- HMAC-SHA256(PROBE_HASH_PEPPER, email_norm)
  first_name   text,
  method       text not null,              -- 'mailto' | 'hn_profile' | 'findymail' | …
  confidence   int not null,               -- 0-100
  found_at     timestamptz not null default now()
);
-- Scoped per lead, not global: the same founder launching a second product is
-- a real case, and resolution must be able to record the contact so the drop
-- can be attributed (§8.3). The one-email guarantee lives on sends, not here.
create unique index if not exists contacts_lead_hash_uniq on contacts (lead_id, email_hash);

-- The suppression scrub (§9.3) and the erasure path both find rows by hash
-- across every lead, which the per-lead unique index above cannot serve.
create index if not exists contacts_email_hash_idx on contacts (email_hash);

-- Global, permanent, hash-only. Raw address is never stored here.
create table if not exists suppressions (
  email_hash  text primary key,
  reason      suppression_reason not null,
  created_at  timestamptz not null default now(),
  detail      text
);

create table if not exists proofs (
  id           uuid primary key default gen_random_uuid(),
  lead_id      uuid not null references leads(id) on delete cascade,
  campaign_id  uuid not null references campaigns(id),
  subject      text,
  html         text,
  text_body    text,
  -- §6: the email hands over remediation, not just diagnosis, so the fix is
  -- part of the proof rather than something the renderer invents.
  fix          text,
  -- §6: recorded even when it fails the bar, so a run of severity 2 findings is
  -- visible as data instead of as silence.
  severity     int,
  evidence_url text,
  meta         jsonb not null default '{}',
  attempts     int not null default 0,
  polls        int not null default 0,     -- observability; budget is elapsed time (§6)
  status       text not null default 'pending',   -- pending|ready|failed|no_proof
  error        text,
  created_at   timestamptz not null default now(),
  ready_at     timestamptz,
  -- §6: the two hour budget is elapsed time from the first request. Both of
  -- these live in the row so a worker restart cannot reset the clock.
  first_requested_at timestamptz,
  next_poll_at       timestamptz
);
create unique index if not exists proofs_lead_uniq on proofs (lead_id);

-- The generate job polls for pending proofs that are due; this is that query.
create index if not exists proofs_status_next_poll_idx on proofs (status, next_poll_at);

create table if not exists sends (
  id            uuid primary key default gen_random_uuid(),
  proof_id      uuid not null references proofs(id),
  campaign_id   uuid not null references campaigns(id),
  contact_id    uuid not null references contacts(id),
  email_hash    text not null,
  approved_by   text not null,
  approved_at   timestamptz not null,
  scheduled_for timestamptz not null,
  sent_at       timestamptz,
  -- Two ids per send, because probe does not talk to SES: Day3 does (§5.1).
  -- `provider_email_id` is Day3's transactional email id ('eml_…'), known the
  -- moment Day3 accepts the message and the join key its webhooks arrive with.
  -- `ses_message_id` is the underlying provider message id, which Day3 relays
  -- on the first delivery event and which is therefore null until then.
  provider      text,                      -- 'day3' | 'dry-run'
  provider_email_id text,
  ses_message_id text,
  unsub_token   text not null unique,
  click_token   text not null unique,      -- /c/:token → click event → evidence_url
  -- 'sending' is the claim: the pacing loop flips queued→sending in one atomic
  -- UPDATE and only then hands the message to the provider, so two processes
  -- can never dispatch the same row (§8.6).
  status        text not null default 'queued',   -- queued|sending|sent|failed|cancelled
  error         text
);

-- §3.2, enforced by the database rather than by application logic.
-- Partial: a failed or cancelled send releases the slot, so a transient
-- provider error can't burn a contact forever. Retries reuse the existing row.
-- 'sending' is in the list because the claim window must not free the slot: a
-- second lead resolving to the same address mid-dispatch would otherwise pass
-- the contact-once check and produce the one thing this index exists to stop.
-- This is the policy lever. Widening it to (email_hash, campaign_id) is the
-- single change that allows a second email from a different product.
create unique index if not exists sends_email_hash_uniq on sends (email_hash)
  where status in ('queued','sending','sent');

-- /hooks/day3 resolves a webhook back to the send it is about, and the same id
-- is the Idempotency-Key probe sent, so it is unique per send.
create unique index if not exists sends_provider_email_id_uniq
  on sends (provider_email_id)
  where provider_email_id is not null;

-- The pacing loop asks for the next due queued row for one campaign, over and
-- over, all day. This index is that query.
create index if not exists sends_due_idx on sends (campaign_id, status, scheduled_for);

-- /hooks/ses resolves an SES notification back to the send that caused it.
create index if not exists sends_ses_message_id_idx on sends (ses_message_id);

create table if not exists events (
  id          bigserial primary key,
  send_id     uuid references sends(id),
  type        text not null,   -- delivery|bounce|complaint|click|unsubscribe|reply
  detail      jsonb not null default '{}',
  occurred_at timestamptz not null default now()
);

-- /sends renders the event list per send.
create index if not exists events_send_type_idx on events (send_id, type);

-- The rolling bounce and complaint rates behind the auto-pause check (§5.5)
-- scan by type over a window.
create index if not exists events_type_occurred_idx on events (type, occurred_at);

-- ---------------------------------------------------------------------------
-- Small durable counters
-- ---------------------------------------------------------------------------

-- The match round robin (§8.2) and the paid lookup month counter (§8.3). Both
-- must survive a worker restart, and neither justifies a table of its own.
create table if not exists app_state (
  key         text primary key,
  value       jsonb not null,
  updated_at  timestamptz not null default now()
);
