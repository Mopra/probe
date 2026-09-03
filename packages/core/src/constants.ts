// Shared constants for the whole pipeline. See PLAN.md §6 and §8.2.

/**
 * The weakest severity probe will mail, where LOWER is stronger (§6).
 *
 * 1 is a defect. 0 is the clean report: every check passed, quoted with the
 * numbers measured against that site minutes earlier. Both are mailed, and 0 is
 * not a weaker 1 but a different statement, so this constant is a floor on
 * pedantry rather than on severity.
 *
 * 2 is never mailed. A severity 2 finding is real but pedantic, and a pedantic
 * finding offered as the reason for writing reads as a pretext, which is worse
 * than no email. "Everything passed" is both truer and more useful than "your
 * redirect chain is three hops".
 */
export const SEVERITY_MAILABLE = 1;

/** Why a lead died before a send. Written once, never overwritten (§8.2). */
export type DropReason =
  | 'platform_domain'
  | 'jurisdiction_blocked'
  | 'no_match'
  | 'suppressed'
  | 'contacted_other_campaign'
  | 'no_contact'
  | 'no_proof'
  | 'generator_failed';

/** Stable order, used for the /health breakdown table. */
export const DROP_REASONS: DropReason[] = [
  'platform_domain',
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
  platform_domain: 'A repo, profile or hosted demo, not a product',
  jurisdiction_blocked: 'Country is on the blocklist',
  no_match: 'Fits no campaign',
  suppressed: 'Address already opted out',
  contacted_other_campaign: 'Address already received a probe email',
  no_contact: 'Cascade found nothing',
  no_proof: 'Generator returned 204',
  generator_failed: '3 failed attempts or 2 hours pending',
};
