// Row types mirror the columns in schema.sql exactly, snake_case included.
// postgres.js is configured with `transform: undefined`, so what comes back
// from a query has these keys verbatim.

export type LeadStatus =
  | 'discovered'
  | 'contact_resolved'
  | 'no_contact'
  | 'matched'
  | 'no_match'
  | 'generating'
  | 'ready'
  | 'approved'
  | 'sent'
  | 'rejected'
  | 'no_proof'
  | 'dropped';

export type SuppressionReason =
  | 'unsubscribed'
  | 'complained'
  | 'bounced'
  | 'replied'
  | 'manual';

export type ProofStatus = 'pending' | 'ready' | 'failed' | 'no_proof';

export type SendStatus = 'queued' | 'sending' | 'sent' | 'failed' | 'cancelled';

/**
 * `leads.drop_reason` is a free text column on purpose: the canonical list
 * lives in @probe/core as DropReason, and @probe/db must not depend on core.
 */
export type DropReasonString = string;

export interface SourceRow {
  id: string;
  name: string;
  kind: string;
  enabled: boolean;
  last_swept_at: Date | null;
  last_error: string | null;
}

export interface CampaignRow {
  id: string;
  slug: string;
  product: string;
  generator_url: string;
  from_name: string;
  from_email: string;
  reply_to: string | null;
  paused: boolean;
  warmup_start: Date | null;
  daily_cap: number;
  timezone: string;
  exclude_tags: string[];
  exclude_keywords: string[];
  created_at: Date;
}

export interface LeadRow {
  id: string;
  source_id: string;
  external_id: string;
  name: string;
  url: string;
  domain: string;
  description: string | null;
  tags: string[];
  launched_at: Date | null;
  discovered_at: Date;
  jurisdiction: string | null;
  jurisdiction_source: string | null;
  jurisdiction_detail: string | null;
  status: LeadStatus;
  campaign_id: string | null;
  drop_reason: string | null;
  notes: string | null;
}

export interface ContactRow {
  id: string;
  lead_id: string;
  email: string | null;
  email_norm: string | null;
  email_hash: string;
  first_name: string | null;
  method: string;
  confidence: number;
  found_at: Date;
}

export interface SuppressionRow {
  email_hash: string;
  reason: SuppressionReason;
  created_at: Date;
  detail: string | null;
}

export interface ProofRow {
  id: string;
  lead_id: string;
  campaign_id: string;
  subject: string | null;
  html: string | null;
  text_body: string | null;
  fix: string | null;
  severity: number | null;
  evidence_url: string | null;
  meta: Record<string, unknown>;
  attempts: number;
  polls: number;
  status: ProofStatus;
  error: string | null;
  created_at: Date;
  ready_at: Date | null;
  first_requested_at: Date | null;
  next_poll_at: Date | null;
}

export interface SendRow {
  id: string;
  proof_id: string;
  campaign_id: string;
  contact_id: string;
  email_hash: string;
  approved_by: string;
  approved_at: Date;
  scheduled_for: Date;
  sent_at: Date | null;
  provider: string | null;
  provider_email_id: string | null;
  ses_message_id: string | null;
  unsub_token: string;
  click_token: string;
  status: SendStatus;
  error: string | null;
}

export interface EventRow {
  id: string;
  send_id: string | null;
  type: string;
  detail: Record<string, unknown>;
  occurred_at: Date;
}
