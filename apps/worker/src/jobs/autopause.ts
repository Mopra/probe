// Auto-pause on rolling bounce and complaint rates (§5.5).
//
// The thresholds in probe.toml are half of AWS's, so probe finds out before
// AWS does. AWS enforces at the account level, which means a cold campaign
// drifting over the line puts every other campaign in the same account at risk
// (§5.1). Pausing early is cheap; being throttled is not.

import { loadConfig, logger } from '@probe/config';
import { insertEvent, listCampaigns, rollingRates, setCampaignPaused } from '@probe/db';

const log = logger('job.autopause');

/**
 * A rate needs a denominator before it means anything. One bounce out of two
 * sends is a 50% bounce rate and is not a signal: it is one bad address on a
 * campaign that has barely started. Pausing on that would stop every campaign
 * on its first warmup morning, every time, and would teach the operator to
 * ignore the pause. Below this many sends in the window, the rate is recorded
 * and nothing is acted on.
 */
export const MIN_VOLUME_FOR_RATE = 20;

/**
 * A complaint pauses the campaign regardless of volume.
 *
 * This used to be an accident of two constants rather than a decision: with a
 * 0.05% threshold and a 20-send floor, the first complaint after 20 sends is a
 * 5% rate, a hundredfold over the line, so it paused. The threshold only starts
 * meaning anything around 2000 sends, which probe will not reach for months.
 *
 * Making it explicit is better than leaving it emergent, because the operator
 * reads the pause reason and has to recognise it as intended. And for cold
 * outreach it IS intended: one person marking a probe email as spam is a signal
 * about the premise, not noise to be averaged away. §5.5's rates are the
 * long-run guard; this is the short-run one.
 */
export const PAUSE_ON_ANY_COMPLAINT = true;

export interface AutoPauseCheck {
  slug: string;
  sent: number;
  bounce_rate: number;
  complaint_rate: number;
  action: 'paused' | 'ok' | 'low_volume' | 'already_paused';
  reason?: string;
}

export interface AutoPauseSummary {
  checked: number;
  paused: number;
  low_volume: number;
  checks: AutoPauseCheck[];
}

export interface RollingRates {
  sent: number;
  bounces: number;
  complaints: number;
  bounce_rate: number;
  complaint_rate: number;
}

export type AutoPauseDecision =
  | { action: 'low_volume' }
  | { action: 'ok' }
  | { action: 'pause'; breaches: string[] };

/**
 * The whole judgement, with no database and no clock in it. Kept separate so
 * the minimum-volume rule is testable and so the thresholds can be read next
 * to the arithmetic that applies them.
 */
export function autoPauseDecision(args: {
  rates: RollingRates;
  complaintThreshold: number;
  bounceThreshold: number;
  minVolume?: number;
}): AutoPauseDecision {
  const minVolume = args.minVolume ?? MIN_VOLUME_FOR_RATE;

  // Checked before the volume floor, and deliberately not a rate: at probe's
  // volumes any complaint at all is worth stopping for.
  if (PAUSE_ON_ANY_COMPLAINT && args.rates.complaints > 0) {
    return {
      action: 'pause',
      breaches: [
        `${args.rates.complaints} complaint${args.rates.complaints === 1 ? '' : 's'} in the window. ` +
          'Any complaint pauses the campaign at these volumes, whatever the rate works out to',
      ],
    };
  }

  if (args.rates.sent < minVolume) return { action: 'low_volume' };

  const breaches: string[] = [];
  if (args.rates.complaint_rate > args.complaintThreshold) {
    breaches.push(
      `complaint rate ${pct(args.rates.complaint_rate)} over ${pct(args.complaintThreshold)}`,
    );
  }
  if (args.rates.bounce_rate > args.bounceThreshold) {
    breaches.push(
      `hard bounce rate ${pct(args.rates.bounce_rate)} over ${pct(args.bounceThreshold)}`,
    );
  }
  return breaches.length > 0 ? { action: 'pause', breaches } : { action: 'ok' };
}

export async function runAutoPause(): Promise<AutoPauseSummary> {
  const cfg = loadConfig();
  const windowDays = cfg.global.rate_window_days;
  const campaigns = await listCampaigns();

  const checks: AutoPauseCheck[] = [];

  for (const campaign of campaigns) {
    const rates = await rollingRates(campaign.id, windowDays);
    const base: AutoPauseCheck = {
      slug: campaign.slug,
      sent: rates.sent,
      bounce_rate: rates.bounce_rate,
      complaint_rate: rates.complaint_rate,
      action: 'ok',
    };

    if (campaign.paused) {
      checks.push({ ...base, action: 'already_paused' });
      continue;
    }

    const decision = autoPauseDecision({
      rates,
      complaintThreshold: cfg.global.complaint_rate_threshold,
      bounceThreshold: cfg.global.bounce_rate_threshold,
    });

    if (decision.action === 'low_volume') {
      log.debug('rate below the minimum volume, not acting', {
        campaign: campaign.slug,
        sent: rates.sent,
        min: MIN_VOLUME_FOR_RATE,
      });
      checks.push({ ...base, action: 'low_volume' });
      continue;
    }
    if (decision.action === 'ok') {
      checks.push(base);
      continue;
    }

    const reason = `${decision.breaches.join(' and ')} over ${windowDays} days on ${rates.sent} sends`;
    await setCampaignPaused(campaign.id, true);
    // Recorded with send_id null and a type of its own, so it never lands in
    // the per-send joins that produce the rates this job reads. Feeding an
    // auto-pause back into the complaint count would be a feedback loop.
    await insertEvent({
      send_id: null,
      type: 'autopause',
      detail: {
        campaign_id: campaign.id,
        campaign_slug: campaign.slug,
        reason,
        window_days: windowDays,
        sent: rates.sent,
        bounces: rates.bounces,
        complaints: rates.complaints,
        bounce_rate: rates.bounce_rate,
        complaint_rate: rates.complaint_rate,
      },
    });
    log.error('campaign auto-paused', { campaign: campaign.slug, reason });
    checks.push({ ...base, action: 'paused', reason });
  }

  const summary: AutoPauseSummary = {
    checked: checks.length,
    paused: checks.filter((c) => c.action === 'paused').length,
    low_volume: checks.filter((c) => c.action === 'low_volume').length,
    checks,
  };
  log.info('autopause complete', {
    checked: summary.checked,
    paused: summary.paused,
    low_volume: summary.low_volume,
  });
  return summary;
}

function pct(rate: number): string {
  return `${(rate * 100).toFixed(3)}%`;
}
