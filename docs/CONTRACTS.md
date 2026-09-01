# probe internal contracts

The exact cross-package API. Every package implements what this file says it
implements, and consumes only what this file says exists. If you need something
that isn't here, add it to your own package and note it at the bottom of this
file under "Additions"; do not invent an export in someone else's package.

Runtime facts that apply everywhere:

- TypeScript, `module: commonjs`, `moduleResolution: node`. **No `.js` extensions
  on relative imports.** Packages compile `src/` to `dist/` via `tsc -b`.
- Node >= 20. Native `fetch`, `node:crypto`, `AbortSignal.timeout` are available.
- Packages export everything through `src/index.ts`.
- Tests are `*.test.ts` next to the source, run by vitest from the repo root.
  They are excluded from the tsc build.
- Never `console.log` in library code. Use the logger (below).
- No secrets in code. Everything comes from `@probe/config`.
- Never write an em dash, en dash, or `--` as sentence punctuation anywhere,
  including comments and UI copy.

---

## @probe/config

`packages/config/src/index.ts`

```ts
export type Weekday = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';

export interface GlobalConfig {
  timezone: string;                 // IANA, e.g. 'Europe/Copenhagen'
  send_days: Weekday[];
  send_window: [string, string];    // ['09:00', '16:00'], local to timezone
  gap_floor_minutes: number;
  gap_jitter: number;               // 0..1
  allowed_countries: string[];      // ISO 3166-1 alpha-2, upper case
  postal_address: string;
  public_base_url: string;          // no trailing slash
  generator_concurrency: number;
  generator_timeout_ms: number;
  generator_budget_ms: number;
  generator_max_attempts: number;
  generator_min_severity: number;
  complaint_rate_threshold: number;
  bounce_rate_threshold: number;
  rate_window_days: number;
  paid_lookup_monthly_cap: number;
}

export interface CampaignConfig {
  slug: string;                     // key of the [campaigns.*] table
  product: string;
  generator_url: string;
  from_name: string;
  from_email: string;
  reply_to?: string;
  daily_cap: number;
  exclude_tags: string[];
  exclude_keywords: string[];
}

export interface ProbeConfig {
  global: GlobalConfig;
  campaigns: CampaignConfig[];      // stable order: file order
}

export class ConfigError extends Error {}

/** Reads probe.toml, validates with zod, applies defaults.
 *  Throws ConfigError if 'DK' appears in allowed_countries (§9.1), if the
 *  window is malformed, or if any campaign is incomplete.
 *  Searches upward from cwd for probe.toml when no path is given. Cached. */
export function loadConfig(opts?: { path?: string; cwd?: string }): ProbeConfig;

/** Test seam: drops the cache. */
export function resetConfigCache(): void;

export interface Env {
  SUPABASE_DB_URL: string;
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_KEY?: string;
  PROBE_HASH_PEPPER: string;
  PROBE_HMAC_SECRET: string;
  PROBE_SEND_ENABLED: boolean;      // parsed: true only for the literal 'true'
  PROBE_PUBLIC_URL?: string;
  PROBE_APPROVER: string;           // default 'morten'
  PROBE_OUTBOX_DIR: string;         // default './outbox'
  DAY3_API_KEY?: string;            // day3_live_... The worker sends through this
  DAY3_API_BASE_URL: string;        // default 'https://day3.app'
  DAY3_WEBHOOK_SECRET?: string;     // whsec_... verifies /hooks/day3
  SNS_ALLOWED_TOPIC_ARNS: string[]; // parsed from comma separated. INBOUND only,
                                    // and required: empty means none, not any
  REPLY_FORWARD_TO?: string;
  PRODUCT_HUNT_TOKEN?: string;
  FINDYMAIL_KEY?: string;
}

/** Validates process.env lazily (never at import time, so a Next build cannot
 *  crash on a missing worker-only secret). Cached. Throws ConfigError listing
 *  every missing required var at once. */
export function loadEnv(): Env;
export function resetEnvCache(): void;

/** public_base_url with PROBE_PUBLIC_URL taking precedence. No trailing slash. */
export function publicBaseUrl(): string;

/** Minimal leveled logger, JSON lines on stdout. Used by every package. */
export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}
export function logger(scope: string): Logger;
```

---

## @probe/core

`packages/core/src/index.ts` re-exports every module below.

### email.ts

```ts
/** Lowercase, trim, strip a +tag from the local part, validate shape.
 *  Returns null for anything that is not a plausible single address. */
export function normalizeEmail(raw: string): string | null;

/** HMAC-SHA256(pepper, emailNorm) as lowercase hex. Never a bare sha256. */
export function hashEmail(emailNorm: string, pepper: string): string;

/** Role addresses we refuse to treat as a founder contact. */
export function isRoleAddress(emailNorm: string): boolean;

/** Addresses on hosts we never contact (example.com, sentry.io ingest, etc). */
export function isDisposableOrJunk(emailNorm: string): boolean;
```

### url.ts

```ts
/** Lowercase host, strip 'www.', drop port, path, query, fragment.
 *  Returns null when the input is not an http(s) URL with a real host. */
export function normalizeDomain(input: string): string | null;

/** Canonical https URL for a lead: scheme forced to https, host normalized,
 *  path preserved, tracking query params dropped. Null when unusable. */
export function normalizeUrl(input: string): string | null;

export function isHttps(input: string): boolean;
```

### hmac.ts

```ts
/** Returns the value for X-Probe-Signature: 'sha256=<hex>'.
 *  Signs `${timestamp}.${rawBody}` with the secret. */
export function signGeneratorRequest(args: {
  secret: string; timestamp: number | string; rawBody: string;
}): string;

/** Constant-time compare plus a 300s freshness window on the timestamp. */
export function verifyGeneratorSignature(args: {
  secret: string; timestamp: number | string; rawBody: string;
  signature: string; nowMs?: number; toleranceSeconds?: number;
}): boolean;

/** URL-safe random token, 32 bytes, base64url. Used for unsub and click. */
export function newToken(): string;
```

### generator.ts  (§6)

```ts
export interface GeneratorRequest {
  lead_id: string;
  product: { name: string; url: string; description: string | null;
             source: string; launched_at: string | null; tags: string[] };
  recipient: { first_name: string | null };   // never the email address
}

export interface GeneratorReady {
  status: 'ready';
  severity: number;
  subject: string;
  html: string;
  text: string;
  fix: string;
  evidence_url: string;
  meta?: Record<string, unknown>;
}
export interface GeneratorPending { status: 'pending'; retry_after?: number; }

export const GeneratorRequestSchema: z.ZodType<GeneratorRequest>;
export const GeneratorReadySchema: z.ZodType<GeneratorReady>;
export const GeneratorPendingSchema: z.ZodType<GeneratorPending>;

export type GeneratorOutcome =
  | { kind: 'ready'; body: GeneratorReady }
  | { kind: 'pending'; retryAfterMs: number }   // clamped to 60_000..1_800_000
  | { kind: 'no_proof' }                        // 204, or severity below the bar
  | { kind: 'error'; status?: number; message: string };

/** One HTTP call to a generator. Signs the request, honours the timeout,
 *  parses and validates the response, clamps retry_after. Never throws for a
 *  transport or protocol failure: returns { kind: 'error' }. */
export function callGenerator(args: {
  url: string; secret: string; request: GeneratorRequest;
  timeoutMs: number; minSeverity: number; fetchImpl?: typeof fetch;
}): Promise<GeneratorOutcome>;

export const RETRY_AFTER_MIN_MS = 60_000;
export const RETRY_AFTER_MAX_MS = 1_800_000;
```

### lint.ts  (§9.2.8)

```ts
export interface LintInput {
  subject: string;
  html: string;
  text: string;
  productName: string;        // 'exit1.dev'
  productDomain: string;      // 'exit1.dev'
  evidenceUrl: string;        // post-rewrite click URL, or the raw evidence url
  unsubscribeUrl: string;
  dataNoticeUrl: string;
  postalAddress: string;
  fromName: string;
  fromEmail: string;
}
export type LintCode =
  | 'forbidden_phrase' | 'product_mention_count' | 'missing_footer_element'
  | 'link_not_permitted' | 'missing_permitted_link' | 'missing_contact_once'
  | 'missing_provenance' | 'empty_subject' | 'subject_too_long'
  | 'closing_question' | 'html_text_divergence' | 'tracking_pixel';
export interface LintViolation { code: LintCode; message: string; where: 'subject'|'html'|'text'|'both'; }
export interface LintResult { ok: boolean; violations: LintViolation[]; }

/** Mechanical enforcement of §9.2. Runs in the dry-run harness and again at
 *  approval; a failure blocks the queue. Pure, no IO. */
export function lintCopy(input: LintInput): LintResult;

export const FORBIDDEN_PATTERNS: { pattern: RegExp; label: string }[];
```

### footer.ts  (§9.2.7)

```ts
export interface FooterInput {
  fromName: string; fromEmail: string; productName: string;
  postalAddress: string; unsubscribeUrl: string; dataNoticeUrl: string;
}
export function renderFooter(input: FooterInput): { html: string; text: string };

/** Appends the footer to a generator body. HTML is injected before </body>
 *  when present, appended otherwise. Never mutates the input. */
export function applyFooter(args: {
  html: string; text: string; footer: { html: string; text: string };
}): { html: string; text: string };

/** Replaces every occurrence of evidenceUrl (href and bare text) with clickUrl
 *  in both bodies. §8.7. */
export function rewriteEvidenceUrl(args: {
  html: string; text: string; evidenceUrl: string; clickUrl: string;
}): { html: string; text: string };

/** Absolute URLs built from the public base. */
export function unsubscribeUrl(base: string, token: string): string;  // `${base}/u/${token}`
export function clickUrl(base: string, token: string): string;        // `${base}/c/${token}`
export function dataNoticeUrl(base: string): string;                  // `${base}/data`
```

### mime.ts

```ts
export interface OutboundMessage {
  fromName: string; fromEmail: string;
  to: string; replyTo?: string;
  subject: string; html: string; text: string;
  unsubscribeUrl: string;
  unsubscribeMailto?: string;
  messageId?: string;          // generated when absent
  date?: Date;
  headers?: Record<string, string>;
}
/** RFC 5322 multipart/alternative with quoted-printable bodies, plus
 *  List-Unsubscribe and List-Unsubscribe-Post: List-Unsubscribe=One-Click
 *  (RFC 8058). CRLF line endings. This is what goes to SES as raw content and
 *  what the dry-run harness writes to ./outbox as .eml. */
export function buildMime(msg: OutboundMessage): string;
```

### pacing.ts  (§5.4)

```ts
export interface WarmupTier { minDay: number; maxDay: number | null; cap: number; }
export const WARMUP_CURVE: WarmupTier[];   // 1-3:5, 4-7:10, 8-14:20, 15-21:35, 22+:50

/** Day 1 is warmupStart itself. Returns 0 when warmupStart is null or future. */
export function warmupDay(warmupStart: Date | string | null, now: Date, timezone: string): number;

/** min(warmup cap for the day, campaign daily_cap). 0 before warmup starts. */
export function dailyCap(args: {
  warmupStart: Date | string | null; campaignDailyCap: number;
  now: Date; timezone: string;
}): number;

/** True when `now` is a configured send day and inside the window, in tz. */
export function inSendWindow(args: {
  now: Date; timezone: string; sendDays: string[]; window: [string, string];
}): boolean;

/** Start and end of today's window as absolute instants. */
export function windowBounds(args: {
  now: Date; timezone: string; window: [string, string];
}): { start: Date; end: Date };

/** remaining window ms / remaining quota, jittered +/- jitter, floored.
 *  Deterministic when `rng` is supplied. Returns floor when quota <= 0. */
export function computeGapMs(args: {
  remainingWindowMs: number; remainingQuota: number;
  gapFloorMinutes: number; jitter: number; rng?: () => number;
}): number;

/** Even spread of `count` slots across [from, end), used at approval time to
 *  pick scheduled_for. Never schedules before `from`. */
export function scheduleSlots(args: {
  from: Date; end: Date; count: number; gapFloorMinutes: number;
  jitter: number; rng?: () => number;
}): Date[];
```

### jurisdiction.ts  (§8.2, §9.1)

```ts
export type JurisdictionSource = 'tld' | 'imprint' | 'hn_profile' | 'whois' | 'html' | 'none';
export interface JurisdictionGuess { country: string | null; source: JurisdictionSource; }

export const CCTLD_TO_COUNTRY: Record<string, string>;

/** '.dk' -> 'DK'. Generic TLDs (.com, .io, .app, .dev) return null: they carry
 *  no country signal and guessing 'US' from '.com' is the expensive error. */
export function countryFromDomain(domain: string): string | null;

/** Scans page text for a postal address, 'Impressum', a country name, a
 *  registered-company line, or a phone country code. Conservative: returns
 *  null unless the signal is unambiguous. */
export function countryFromText(text: string): string | null;

/** HN profile 'about' free text, e.g. 'SF, CA' or 'Berlin, Germany'. */
export function countryFromLocationString(location: string): string | null;

/** Merges guesses in priority order (first non-null wins) and reports the
 *  source that produced it. */
export function resolveJurisdiction(guesses: JurisdictionGuess[]): JurisdictionGuess;

/** THE GATE. Unknown (null) is blocked, never benefit of the doubt. */
export function isAllowedJurisdiction(country: string | null, allowed: string[]): boolean;
```

### match.ts  (§8.2)

```ts
export interface MatchInput {
  name: string; url: string; description: string | null; tags: string[];
}
export interface MatchCandidate {
  slug: string; excludeTags: string[]; excludeKeywords: string[];
}
export type MatchReason =
  | 'matched' | 'not_https' | 'excluded_tag' | 'excluded_keyword' | 'no_campaign';
export interface MatchResult {
  slug: string | null;
  reason: MatchReason;
  detail?: string;
}
/** Cheap and rule based, no LLM. Requires a reachable-looking https URL.
 *  Excludes on tags then description keywords. Tiebreak between surviving
 *  campaigns: prefer the one that looks probe-able (a public API or docs
 *  surface in the description or tags), then round robin via `rrCounter`. */
export function matchLead(args: {
  lead: MatchInput; candidates: MatchCandidate[]; rrCounter: number;
}): MatchResult;

/** True when the description or tags suggest an API or docs surface. */
export function looksProbeable(lead: MatchInput): boolean;
```

### inbound.ts  (§5.3)

```ts
export type Headers = Record<string, string | string[] | undefined>;
/** Auto-Submitted != no, Precedence: bulk|auto_reply|junk, X-Autoresponse,
 *  X-Autoreply, X-Auto-Response-Suppress, or a bounce-shaped From. */
export function isAutomatedMessage(headers: Headers): boolean;

/** Pulls the first plausible address out of a From header value. */
export function parseFromAddress(from: string | undefined): string | null;
```

### sns.ts  (§8.7)

```ts
export interface SnsEnvelope {
  Type: string; MessageId: string; TopicArn?: string; Subject?: string;
  Message: string; Timestamp: string; SignatureVersion: string;
  Signature: string; SigningCertURL: string; SubscribeURL?: string; Token?: string;
}
/** Verifies the SHA1withRSA (v1) or SHA256withRSA (v2) signature over the
 *  canonical string, after checking SigningCertURL is https on an
 *  amazonaws.com host. Caches fetched certificates in memory. */
export function verifySnsSignature(env: SnsEnvelope, fetchImpl?: typeof fetch): Promise<boolean>;

export type SesEventKind =
  | 'delivery' | 'bounce' | 'complaint' | 'send' | 'reject'
  | 'inbound' | 'open' | 'click' | 'unknown';
export interface SesEvent {
  kind: SesEventKind;
  messageId: string | null;
  recipients: string[];
  /** hard bounce or any complaint: suppress immediately */
  suppress: boolean;
  reason: 'bounced' | 'complained' | null;
  detail: Record<string, unknown>;
}
/** Parses the JSON inside SnsEnvelope.Message into a normalized SesEvent.
 *  Understands both the SES notification shape and the event-publishing
 *  (eventType) shape, and distinguishes inbound receipt from notifications. */
export function parseSesMessage(message: string): SesEvent;
```

### severity.ts / constants

```ts
export const SEVERITY_MAILABLE = 1;
export type DropReason =
  | 'jurisdiction_blocked' | 'no_match' | 'suppressed'
  | 'contacted_other_campaign' | 'no_contact' | 'no_proof' | 'generator_failed';
export const DROP_REASONS: DropReason[];
export const DROP_REASON_LABELS: Record<DropReason, string>;
```

---

## @probe/db

`packages/db/src/index.ts`. Raw SQL over `postgres` (postgres.js). Server side
only, service role. No RLS surface.

Files: `packages/db/schema.sql` (full current schema, exactly §7 plus what is
listed below), `packages/db/migrations/0001_init.sql` (identical content, the
first migration), `packages/db/scripts/migrate.ts` (applies pending migrations,
tracked in a `_migrations` table).

Additions to §7 that the app needs, all additive and all justified:

- `campaigns.exclude_tags text[] not null default '{}'` and
  `campaigns.exclude_keywords text[] not null default '{}'` so matching reads
  the table, not the file (§11).
- `campaigns.reply_to`, already in §7.
- `leads.jurisdiction_detail text` for the raw signal behind the guess.
- `proofs.severity int`, `proofs.fix text`, `proofs.first_requested_at timestamptz`,
  `proofs.next_poll_at timestamptz` so the two-hour elapsed budget and the
  poll schedule live in the row rather than in memory.
- `sends.subject text`, `sends.html text`, `sends.text_body text` are NOT added.
  The rendered bytes are recomposed at send time from the proof plus the footer,
  so there is one source of truth for copy.
- `events.type` gains no new values.
- `app_state (key text primary key, value jsonb not null, updated_at timestamptz)`
  for the round robin counter and the paid-lookup month counter.

```ts
import type { Sql } from 'postgres';

export function getSql(): Sql;                 // lazily connects, singleton
export function closeSql(): Promise<void>;
export type Tx = Sql;                          // transaction handle
export function withTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;

// ---- row types (snake_case, mirroring the columns) ----
export type LeadStatus =
  | 'discovered' | 'contact_resolved' | 'no_contact' | 'matched' | 'no_match'
  | 'generating' | 'ready' | 'approved' | 'sent' | 'rejected' | 'no_proof' | 'dropped';
export type SuppressionReason = 'unsubscribed' | 'complained' | 'bounced' | 'replied' | 'manual';
export interface SourceRow { id: string; name: string; kind: string; enabled: boolean;
  last_swept_at: Date | null; last_error: string | null; }
export interface CampaignRow { id: string; slug: string; product: string; generator_url: string;
  from_name: string; from_email: string; reply_to: string | null; paused: boolean;
  warmup_start: Date | null; daily_cap: number; timezone: string;
  exclude_tags: string[]; exclude_keywords: string[]; created_at: Date; }
export interface LeadRow { id: string; source_id: string; external_id: string; name: string;
  url: string; domain: string; description: string | null; tags: string[];
  launched_at: Date | null; discovered_at: Date; jurisdiction: string | null;
  jurisdiction_source: string | null; jurisdiction_detail: string | null;
  status: LeadStatus; campaign_id: string | null; drop_reason: string | null; notes: string | null; }
export interface ContactRow { id: string; lead_id: string; email: string | null;
  email_norm: string | null; email_hash: string; first_name: string | null;
  method: string; confidence: number; found_at: Date; }
export interface SuppressionRow { email_hash: string; reason: SuppressionReason;
  created_at: Date; detail: string | null; }
export interface ProofRow { id: string; lead_id: string; campaign_id: string;
  subject: string | null; html: string | null; text_body: string | null; fix: string | null;
  severity: number | null; evidence_url: string | null; meta: Record<string, unknown>;
  attempts: number; polls: number; status: 'pending' | 'ready' | 'failed' | 'no_proof';
  error: string | null; created_at: Date; ready_at: Date | null;
  first_requested_at: Date | null; next_poll_at: Date | null; }
export interface SendRow { id: string; proof_id: string; campaign_id: string; contact_id: string;
  email_hash: string; approved_by: string; approved_at: Date; scheduled_for: Date;
  sent_at: Date | null; ses_message_id: string | null; unsub_token: string; click_token: string;
  status: 'queued' | 'sent' | 'failed' | 'cancelled'; error: string | null; }
export interface EventRow { id: string; send_id: string | null; type: string;
  detail: Record<string, unknown>; occurred_at: Date; }

// ---- sources ----
export function upsertSource(s: { id: string; name: string; kind: string; enabled?: boolean }): Promise<void>;
export function listSources(): Promise<SourceRow[]>;
export function markSweepOk(id: string): Promise<void>;
export function markSweepError(id: string, error: string): Promise<void>;

// ---- campaigns ----
/** Upserts by slug. Overwrites product, generator_url, from_*, reply_to,
 *  daily_cap, timezone, exclude_*. NEVER touches paused or warmup_start. */
export function seedCampaigns(campaigns: Array<{
  slug: string; product: string; generator_url: string; from_name: string;
  from_email: string; reply_to?: string; daily_cap: number; timezone: string;
  exclude_tags: string[]; exclude_keywords: string[];
}>): Promise<void>;
export function listCampaigns(): Promise<CampaignRow[]>;
export function getCampaignBySlug(slug: string): Promise<CampaignRow | null>;
export function getCampaign(id: string): Promise<CampaignRow | null>;
export function setCampaignPaused(id: string, paused: boolean): Promise<void>;
export function pauseAllCampaigns(): Promise<number>;      // big red button, returns rows hit
export function startWarmup(id: string, day: string): Promise<void>;   // 'YYYY-MM-DD'

// ---- leads ----
export interface NewLead {
  source_id: string; external_id: string; name: string; url: string; domain: string;
  description: string | null; tags: string[]; launched_at: Date | null;
}
/** on conflict (source_id, external_id) do nothing, and on conflict (domain)
 *  do nothing. Returns the row when inserted, null when it was a duplicate. */
export function insertLead(lead: NewLead): Promise<LeadRow | null>;
export function getLead(id: string): Promise<LeadRow | null>;
export function listLeadsByStatus(status: LeadStatus, limit?: number): Promise<LeadRow[]>;
export function setLeadJurisdiction(id: string, j: {
  country: string | null; source: string | null; detail?: string | null }): Promise<void>;
export function setLeadStatus(id: string, status: LeadStatus, campaignId?: string | null): Promise<void>;
/** Sets status to the matching terminal state and writes drop_reason, but
 *  ONLY when drop_reason is currently null. Never overwrites (§8.2). */
export function dropLead(id: string, reason: DropReasonString, status?: LeadStatus): Promise<void>;
export type DropReasonString = string;
export interface LeadFilter {
  status?: LeadStatus; dropReason?: string; sourceId?: string; campaignId?: string;
  jurisdiction?: string; q?: string; limit?: number; offset?: number;
}
export interface LeadListItem extends LeadRow {
  campaign_slug: string | null; contact_email: string | null; proof_status: string | null;
}
export function listLeads(f: LeadFilter): Promise<LeadListItem[]>;
export function countLeads(f: LeadFilter): Promise<number>;

// ---- contacts ----
export function insertContact(c: {
  lead_id: string; email: string; email_norm: string; email_hash: string;
  first_name: string | null; method: string; confidence: number;
}): Promise<ContactRow>;
export function getContactForLead(leadId: string): Promise<ContactRow | null>;

// ---- suppressions ----
export function isSuppressed(emailHash: string): Promise<boolean>;
export function suppressedHashes(hashes: string[]): Promise<Set<string>>;
/** Inserts (on conflict do nothing) AND scrubs contacts.email/email_norm for
 *  that hash in the same transaction (§9.3). Idempotent. */
export function addSuppression(a: {
  email_hash: string; reason: SuppressionReason; detail?: string | null;
}): Promise<void>;
export function listSuppressions(limit?: number): Promise<SuppressionRow[]>;
/** GDPR erasure across every table, keyed by hash. Returns per-table counts. */
export function eraseByHash(emailHash: string): Promise<Record<string, number>>;

// ---- proofs ----
export function createProof(p: { lead_id: string; campaign_id: string }): Promise<ProofRow>;
export function getProof(id: string): Promise<ProofRow | null>;
export function getProofForLead(leadId: string): Promise<ProofRow | null>;
/** Rows with status 'pending' whose next_poll_at is due or null. */
export function duePendingProofs(now: Date, limit?: number): Promise<ProofRow[]>;
export function markProofAttempt(id: string, patch: {
  attempts?: number; polls?: number; next_poll_at?: Date | null;
  first_requested_at?: Date | null; error?: string | null;
}): Promise<void>;
export function markProofReady(id: string, p: {
  subject: string; html: string; text_body: string; fix: string; severity: number;
  evidence_url: string; meta: Record<string, unknown>;
}): Promise<void>;
export function markProofNoProof(id: string, detail?: string): Promise<void>;
export function markProofFailed(id: string, error: string): Promise<void>;

// ---- the approval queue ----
export interface QueueItem {
  proof: ProofRow; lead: LeadRow; campaign: CampaignRow; contact: ContactRow;
}
/** Proofs ready and not yet approved, oldest first. Joins in everything
 *  /queue needs so the page is one query. */
export function listQueue(limit?: number): Promise<QueueItem[]>;
export function getQueueItem(proofId: string): Promise<QueueItem | null>;

// ---- sends ----
export function createSend(s: {
  proof_id: string; campaign_id: string; contact_id: string; email_hash: string;
  approved_by: string; scheduled_for: Date; unsub_token: string; click_token: string;
}): Promise<SendRow>;
export class ContactedAlreadyError extends Error {}   // thrown on sends_email_hash_uniq
export function hasLiveSend(emailHash: string): Promise<boolean>;
export function getSend(id: string): Promise<SendRow | null>;
export function getSendByUnsubToken(token: string): Promise<SendRow | null>;
export function getSendByClickToken(token: string): Promise<(SendRow & { evidence_url: string | null }) | null>;
export function getSendBySesMessageId(id: string): Promise<SendRow | null>;
/**
 * Next due row for the campaign, CLAIMED by flipping it to 'sending' in one
 * atomic UPDATE, and returned.
 *
 * The claim has to be the mutation. This used to SELECT ... FOR UPDATE SKIP
 * LOCKED inside a transaction that committed before the function returned, and
 * this comment used to say "so two loops can never grab the same row" -- which
 * was false: the lock was released while the row was still 'queued', and nothing
 * marked it taken until the provider had already accepted the message. Two
 * processes (the daemon plus one `cli send`, or two daemons overlapping across a
 * restart) could both claim and both send. sends_email_hash_uniq cannot catch
 * that, because the row already exists.
 */
export function claimNextDueSend(campaignId: string, now: Date): Promise<SendRow | null>;
/** Puts a claimed row back on the queue, consuming nothing. */
export function releaseSend(id: string): Promise<void>;
/** Rows left in 'sending' by a process that died mid-dispatch. Ambiguous by
 *  nature: whether the provider accepted the message is unknowable from here. */
export function stuckSendingSends(olderThanMinutes?: number): Promise<SendRow[]>;
/** Resolves those rows to 'failed' so they stop holding a contact-once slot and
 *  their proofs return to /queue. Called on worker boot. Never re-queues: the
 *  message may already have gone out. */
export function reconcileStuckSends(olderThanMinutes?: number): Promise<SendRow[]>;
/** Records the provider's acceptance. Guarded on 'sending', so only the process
 *  that claimed the row may complete it; false means something else resolved it
 *  first. `providerEmailId` is Day3's `eml_...`. */
export function markSendSent(
  id: string,
  p: { providerEmailId: string; provider?: string },
): Promise<boolean>;
/** Fills in the SES message id when the first Day3 event carries it. */
export function setSendProviderMessageId(id: string, sesMessageId: string): Promise<void>;
/** §8.7. How /hooks/day3 resolves a webhook back to the send it is about. */
export function getSendByProviderEmailId(id: string): Promise<SendRow | null>;
export function markSendFailed(id: string, error: string): Promise<void>;
export function cancelSend(id: string, reason: string): Promise<void>;
export function sentTodayCount(campaignId: string, timezone: string, now: Date): Promise<number>;
export function listSends(f: { campaignId?: string; status?: string; limit?: number; offset?: number }):
  Promise<Array<SendRow & { campaign_slug: string; lead_name: string; lead_id: string;
    subject: string | null; contact_email: string | null }>>;

// ---- events ----
export function insertEvent(e: { send_id: string | null; type: string;
  detail?: Record<string, unknown>; occurred_at?: Date }): Promise<void>;
export function listEventsForSend(sendId: string): Promise<EventRow[]>;

// ---- app state ----
export function getState<T>(key: string, fallback: T): Promise<T>;
export function setState(key: string, value: unknown): Promise<void>;
/** Atomic read-modify-write of an integer counter, returns the new value. */
export function bumpCounter(key: string, by?: number): Promise<number>;

// ---- stats (§10) ----
export interface DashboardStats {
  swept_today: number; matched_today: number; contacts_today: number;
  proofs_ready: number; awaiting_approval: number; sent_today: number;
  clicks_today: number; replies_today: number; sent_total: number;
  campaigns: Array<{ slug: string; paused: boolean; warmup_day: number;
    daily_cap: number; sent_today: number }>;
  send_enabled: boolean;
}
export function dashboardStats(timezone: string, now: Date): Promise<DashboardStats>;

export interface HealthStats {
  sources: SourceRow[];
  generator: { ready: number; no_proof: number; failed: number; pending: number };
  rates: { window_days: number; sent: number; bounces: number; complaints: number;
           bounce_rate: number; complaint_rate: number };
  drop_reasons: Array<{ reason: string; count: number; share_of_matched: number }>;
  jurisdiction: { swept: number; blocked: number; share_blocked: number;
                  top_countries: Array<{ country: string | null; count: number }> };
  contacted_other_campaign: { count: number; share_of_matched: number };
}
export function healthStats(windowDays: number): Promise<HealthStats>;

/** Rolling rates used by the auto-pause check (§5.5). */
export function rollingRates(campaignId: string, days: number):
  Promise<{ sent: number; bounces: number; complaints: number;
            bounce_rate: number; complaint_rate: number }>;
```

---

## apps/worker

`apps/worker/src/`

- `index.ts` registers cron and starts the send daemon under systemd.
- `cli.ts` is the operator entry point: `sweep | resolve | generate | send |
  seed | dry-run | migrate-check | autopause`. Every job is runnable one-shot.
- `jobs/sweep.ts` `runSweep()`, `jobs/resolve.ts` `runResolve()`,
  `jobs/generate.ts` `runGenerate()`, `jobs/send.ts` `runSendDaemon()` and
  `sendOnce()`, `jobs/autopause.ts` `runAutoPause()`.
- `sources/index.ts` exports `SOURCES: Source[]` where
  `interface Source { id: string; name: string; kind: 'api'|'rss'|'scrape';
   sweep(): Promise<RawLead[]> }` and
  `interface RawLead { external_id: string; name: string; url: string;
   description: string | null; tags: string[]; launched_at: Date | null;
   submitter?: { handle?: string; profile_url?: string } }`.
  Implement `show-hn.ts` (Algolia, `search_by_date?tags=show_hn`) and
  `product-hunt.ts` (GraphQL, needs PRODUCT_HUNT_TOKEN, disabled without one).
  The other nine directories from §8.1 are stubs that throw `NotImplemented`
  and ship `enabled: false`.
- `contact/index.ts` exports `resolveContact(lead, opts): Promise<ContactHit | null>`
  where `interface ContactHit { email: string; first_name: string | null;
  method: string; confidence: number }`, running the §8.3 cascade in order and
  stopping at the first hit: mailto pages, HN profile, PH maker profile,
  security.txt / humans.txt, whois, paid lookup (last, capped, off without a key).
- `send/ses.ts` `sendRaw(mime, opts): Promise<{ messageId: string }>` plus a
  dry-run implementation that writes `./outbox/<send-id>.eml`, and
  `send/render.ts` `renderSend(...)` which composes proof + footer + click
  rewrite into an `OutboundMessage` and lints it before returning.

The worker never bypasses: suppression is checked before resolution, before
generation, and again immediately before dispatch. `PROBE_SEND_ENABLED` is
checked before every single send.

## apps/web

Next.js 15 App Router, server components, Tailwind v4, no client state library.
Routes exactly as §12, plus `/hooks/day3`. `/u/:token` must be the most reliable
thing in the repo: no database write can make it 404, and it never requires auth.

Cloudflare Access protects everything except `/u`, `/c`, `/data` and `/hooks/*`.
The middleware **verifies** the `Cf-Access-Jwt-Assertion` JWT against the team's
published keys and checks the AUD tag (`app/lib/cf-access.ts`); it does not trust
`Cf-Access-Authenticated-User-Email`, which it strips from every inbound request
and re-sets only from a verified assertion. `CF_ACCESS_REQUIRED` now fails
closed: only the literal `false` turns the gate off.

---

## Additions

Anything a package adds beyond this file goes here, appended, with a one line
reason.

- `@probe/core` `lint.ts` exports `SUBJECT_MAX_LENGTH` (120) and
  `HTML_TEXT_MIN_SIMILARITY` (0.5), so the queue UI and the dry-run harness can
  state a limit rather than repeat the number.
- `@probe/core` `generator.ts`: the `no_proof` outcome carries an optional
  `severity`, so a finding dropped for being weaker than the bar can still be
  recorded on the proof row (§6).
- `@probe/core` `sns.ts` exports `snsCanonicalString(env)`, so the exact bytes
  the SNS signature covers can be asserted directly in a test.
- `@probe/core` `sns.ts` exports `isValidSigningCertUrl(url)`, so the webhook
  route can reject a hostile `SigningCertURL` before doing any other work.
- `@probe/core` `sns.ts` exports `clearSnsCertCache()`, a test seam for the
  module level certificate cache.
- `@probe/core` gains `compose.ts`, exporting `composeMessage`,
  `productDomainOf` and `describeLint`. Added in the integration pass: the
  original contract left message composition to each app, and apps/web and
  apps/worker had each written it. They cannot import each other, so the two
  copies would drift, and the two things they were drifting on are the footer
  and the copy lint. `apps/worker/src/send/render.ts` and
  `apps/web/app/lib/render.ts` are now thin row-to-input mappers over this one
  function, which is what makes the queue's raw `.eml` preview genuinely the
  bytes that get dispatched.
- `@probe/db` `filters.ts` exports `buildLeadWhere`, `buildSendWhere`,
  `clampLimit`, `clampOffset`, `likePattern`, `statusForDropReason` and
  `MATCHED_OR_BEYOND_DROP_REASONS`, so the filter composition behind
  `listLeads` and `listSends` is unit testable with no database.
- `@probe/db` `client.ts` exports `usesPooler`, `isUniqueViolation` and
  `UNIQUE_VIOLATION`, so `23505` is interpreted in exactly one place and the
  Supabase pooler's no-prepared-statements rule is asserted in a test.
- `@probe/db` `queue.ts` exports `prefixedSelect` and `unprefix`: `/queue`
  needs four whole rows from one query and proofs and leads share column names.
- `apps/worker` `send/ses.ts` adds `readonly kind: 'dry-run' | 'ses'` to
  `Sender`, so "dry-run is the default" (§3.1 rule 4) is directly assertable.
- `apps/worker` `send/runtime.ts` reads the send-related environment with a
  fail-closed `sendEnabled()`: `loadEnv()` throws without a database url, and
  the M0 harness has to run on a laptop with no environment at all. Failing
  closed means a broken environment can never enable sending.
- `events.type` gains `'autopause'` (`send_id: null`), recording why a campaign
  was paused. Reusing `'bounce'` or `'complaint'` would feed the auto-pause
  back into `rollingRates` as a feedback loop. The column is free text, so no
  schema change is implied.

### The Day3 send path (§5.1)

probe no longer holds AWS credentials. These entries replace the SES sender.

- `@probe/config` `env.ts` gains `DAY3_API_KEY`, `DAY3_API_BASE_URL`,
  `DAY3_WEBHOOK_SECRET` and drops `AWS_REGION`, `AWS_ACCESS_KEY_ID`,
  `AWS_SECRET_ACCESS_KEY`, `SES_CONFIGURATION_SET`. Nothing in probe talks to
  AWS except the inbound SNS webhook, which needs no credentials.
- `@probe/config` `env.ts` exports `sendPreflight(): PreflightProblem[]` and
  `assertSendReady()`. Everything that must be true before real mail can leave,
  in one place, so `cli preflight` and the worker's boot check cannot disagree.
  Only consulted when `PROBE_SEND_ENABLED` is true: demanding a Day3 key on a
  laptop would break the M0 harness §13 says to live in for two weeks.
- `@probe/core` gains `day3.ts`, exporting `verifyDay3Signature`,
  `parseDay3Event`, `computeDay3Signature`, `day3SigningPayload` and
  `DAY3_SIGNATURE_HEADER`. The receiving half of the provider contract, and the
  security boundary around every suppression write a bounce or complaint causes,
  so it fails closed on a missing secret. `parseDay3Event` suppresses only on a
  `Permanent` bounce or any complaint.
- `@probe/core` `lint.ts` `LintInput` gains optional `recipientDomain`. A url on
  the RECIPIENT's own domain is permitted in the body alongside the three
  required links. This is not a loophole in the three-link rule, it is what the
  rule was about: §9.2.5 forbids a fourth link because a fourth link is a funnel,
  and a url pointing at the recipient's own broken page is the evidence. Found by
  running the real exit1 generator's output through the lint: four of its five
  finding kinds quote the founder's own url, and all four were being dropped as
  `generator_failed`. Absent means the stricter three-link reading.
- `@probe/core` `lint.ts` exports `placeholderPostalAddress(address)` and adds
  the `placeholder_postal_address` code. The README always claimed the lint
  blocked a placeholder postal address and it did not: the footer check only
  proves the configured string reached both bodies, which
  `Pradsgaard Labs, <street>, <zip> <city>, Denmark` satisfies perfectly.
- `@probe/core` `pacing.ts` exports `curveCap(day)` and
  `capForWarmupDay(day, dailyCap)`, so the dashboard can show the cap that
  actually applies today instead of `daily_cap`, which overstated it tenfold on
  warmup day one.
- `@probe/core` `compose.ts` `ComposeInput` gains `recipientDomain`, passed
  through to the lint by both apps' render mappers.
- `@probe/db` `filters.ts` exports `LIVE_SEND_STATUSES` and
  `LIVE_SEND_STATUS_SQL`, the statuses that occupy a contact-once slot. One
  canonical list, because migration 0002 added `'sending'` and three separate
  hand-written copies had to be found and widened.
- `@probe/db` `sends.ts`: see the atomic claim above. `SendRow` gains `provider`
  and `provider_email_id`; `SendStatus` gains `'sending'`.
- `@probe/db` `stats.ts` counts only `detail->>'bounce_type' = 'Permanent'` in
  both rate queries. §5.5's threshold is a *hard* bounce rate, and counting soft
  bounces auto-paused a campaign over a full mailbox.
- `apps/worker` `send/ses.ts` becomes `send/sender.ts`. `Sender.send` takes an
  `OutboundSend` (the parts, plus `mime` as a preview) rather than raw MIME, and
  returns `{ providerEmailId, provider }`. `kind` is `'dry-run' | 'day3'`.
- `apps/worker` gains `send/day3.ts`: `day3Send(config, input, idempotencyKey)`.
  The idempotency key is the send row's id and nothing else, which is what makes
  a retry after an ambiguous timeout a replay rather than a second email.
  `Day3SendError` carries `retryable`, false for a refusal that can never
  succeed (`email_suppressed`, `domain_not_verified`).
- `apps/web` gains `app/lib/cf-access.ts`: `verifyAccessJwt`, `teamCertsUrl`,
  `clearAccessKeyCache`. Edge-runtime safe (Web Crypto, no node builtins), which
  is why it lives here and not in `@probe/core`.
- `apps/web` gains `/hooks/day3`. `/hooks/ses` is now inbound-only, and its
  `SNS_ALLOWED_TOPIC_ARNS` allowlist is mandatory: empty means none, where it
  used to mean any.
- `apps/web` `actions.ts` gains `startCampaignWarmup`. `@probe/db`'s
  `startWarmup` had no caller at all, so the runbook instruction to set
  `warmup_start` described something the software could not do -- and without it
  `dailyCap()` is 0 for every day and nothing ever sends.

### Day3's side of the contract

One change was needed in day3.app for probe to work at all: `POST /v1/emails`
gains an optional `list_unsubscribe` field, one https URL, from which Day3 emits
the RFC 8058 header pair. `List-Unsubscribe` and `List-Unsubscribe-Post` are
reserved header names on that API and stay reserved, so this field is the only
door to them, which is what keeps the bracket and One-Click forms correct by
construction. probe cannot send cold outreach without one-click unsubscribe
(§9.3), and Day3 had no way to express it. See `day3.app/docs/api-v1-spec.md`
§2.0.
