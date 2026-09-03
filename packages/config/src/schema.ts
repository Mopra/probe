import { z } from 'zod';

/**
 * Zod schemas for probe.toml. probe.toml is authoritative for key names; this
 * file is authoritative for what a valid value looks like. Everything that has
 * a sensible default gets one here so a minimal file still boots.
 */

export const WeekdaySchema = z.enum(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);
export type Weekday = z.infer<typeof WeekdaySchema>;

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** 'HH:MM' to minutes past midnight. Only call on a string that matched HHMM. */
export function minutesOfDay(hhmm: string): number {
  const [h, m] = hhmm.split(':');
  return Number(h) * 60 + Number(m);
}

const TimeSchema = z.string().regex(HHMM, "must be 'HH:MM' in 24 hour form");

const SendWindowSchema = z
  .tuple([TimeSchema, TimeSchema])
  .refine((w) => minutesOfDay(w[0]) < minutesOfDay(w[1]), {
    message: 'send_window start must be earlier than end',
  });

const CountrySchema = z
  .string()
  .trim()
  .transform((c) => c.toUpperCase())
  .refine((c) => /^[A-Z]{2}$/.test(c), {
    message: 'blocked_countries entries must be ISO 3166-1 alpha-2 codes',
  });

/**
 * A from_email plausible enough to be a real sending identity. Not RFC 5322
 * complete on purpose: the point is to catch a typo in the config file, not to
 * validate arbitrary addresses.
 */
const FromEmailSchema = z
  .string()
  .trim()
  .refine((v) => /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(v), {
    message: 'must be a plausible email address',
  });

const HttpsUrlSchema = z
  .string()
  .trim()
  .min(1)
  .refine((v) => {
    try {
      return new URL(v).protocol === 'https:';
    } catch {
      return false;
    }
  }, { message: 'must be an absolute https URL' });

/** Public base URL, trailing slash stripped so callers can always concatenate. */
const BaseUrlSchema = z
  .string()
  .trim()
  .min(1)
  .refine((v) => {
    try {
      const u = new URL(v);
      return u.protocol === 'https:' || u.protocol === 'http:';
    } catch {
      return false;
    }
  }, { message: 'must be an absolute http(s) URL' })
  .transform((v) => v.replace(/\/+$/, ''));

/**
 * CAN-SPAM requires a real physical postal address in the footer (§9.2.7).
 *
 * Only presence is checked here. Whether the value is a REAL address rather
 * than the committed placeholder is a content rule, so it belongs to the copy
 * lint (§9.2.8) and to the send preflight, not to the TOML parser: refusing to
 * parse probe.toml over a footer string would take down every screen that reads
 * config, including the ones that must never be down, for a problem that
 * cannot reach a recipient anyway. The lint blocks approval and dispatch, and
 * the dry-run harness shows it on every fixture, which is a better feedback
 * loop than a parse error.
 */
const PostalAddressSchema = z.string().trim().min(1);

export const GlobalSchema = z.object({
  timezone: z.string().min(1).default('Europe/Copenhagen'),
  send_days: z.array(WeekdaySchema).min(1).default(['mon', 'tue', 'wed', 'thu', 'fri']),
  send_window: SendWindowSchema.default(['09:00', '16:00']),
  gap_floor_minutes: z.number().int().min(1).default(4),
  gap_jitter: z.number().min(0).max(1).default(0.4),
  // §9.1. A blocklist, not an allowlist: everything not named here is
  // contactable, INCLUDING a lead whose country could not be established.
  blocked_countries: z.array(CountrySchema).default(['DK', 'DE']),
  postal_address: PostalAddressSchema,
  public_base_url: BaseUrlSchema.default('http://localhost:3000'),
  generator_concurrency: z.number().int().min(1).default(3),
  generator_timeout_ms: z.number().int().min(1000).default(30_000),
  // §6: the budget is elapsed time, not poll count. Two hours by default.
  generator_budget_ms: z.number().int().min(60_000).default(7_200_000),
  generator_max_attempts: z.number().int().min(1).default(3),
  // §6: probe mails severity 1 only. Raising this number only ever sends less.
  generator_min_severity: z.number().int().min(1).default(1),
  complaint_rate_threshold: z.number().min(0).max(1).default(0.0005),
  bounce_rate_threshold: z.number().min(0).max(1).default(0.03),
  rate_window_days: z.number().int().min(1).default(7),
  paid_lookup_monthly_cap: z.number().int().min(0).default(50),
});

export const CampaignSchema = z.object({
  product: z.string().min(1),
  generator_url: HttpsUrlSchema,
  from_name: z.string().min(1),
  from_email: FromEmailSchema,
  reply_to: FromEmailSchema.optional(),
  daily_cap: z.number().int().min(0).default(50),
  exclude_tags: z.array(z.string()).default([]),
  exclude_keywords: z.array(z.string()).default([]),
});

export const FileSchema = z.object({
  global: GlobalSchema,
  campaigns: z.record(z.string(), CampaignSchema).default({}),
});

export type ParsedFile = z.infer<typeof FileSchema>;
