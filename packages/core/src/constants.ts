// Shared constants for the whole pipeline. See PLAN.md §6 and §8.2.

/**
 * probe mails severity 1 only (§6). A severity 2 finding is real but pedantic,
 * and a pedantic finding reads as a pretext, which is worse than no email.
 */
export const SEVERITY_MAILABLE = 1;

/** Why a lead died before a send. Written once, never overwritten (§8.2). */
export type DropReason =
  | 'jurisdiction_blocked'
  | 'no_match'
  | 'suppressed'
  | 'contacted_other_campaign'
  | 'no_contact'
  | 'no_proof'
  | 'generator_failed';

/** Stable order, used for the /health breakdown table. */
export const DROP_REASONS: DropReason[] = [
  'jurisdiction_blocked',
  'no_match',
  'suppressed',
  'contacted_other_campaign',
  'no_contact',
  'no_proof',
  'generator_failed',
];

/** Labels taken verbatim from the §8.2 drop accounting table. */
export const DROP_REASON_LABELS: Record<DropReason, string> = {
  jurisdiction_blocked: 'Country not on the allowlist, or unknown',
  no_match: 'Fits no campaign',
  suppressed: 'Address already opted out',
  contacted_other_campaign: 'Address already received a probe email',
  no_contact: 'Cascade found nothing',
  no_proof: 'Generator returned 204',
  generator_failed: '3 failed attempts or 2 hours pending',
};
