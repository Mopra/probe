// The plausibility screen: is this address somebody's inbox at all?
//
// probe was paused at a 15% hard bounce rate, 5 of the first 33 sends, all of
// them scraped off product sites. PLAN.md rules out asking the recipient's
// mail server (SMTP RCPT probing), so the screen reads the address and the
// product instead, in two stages:
//
//   1. junkReason, the deterministic rules in @probe/core. Free, certain, and
//      enough for three of the five bounces.
//   2. An LLM through OpenRouter, only for what passes the rules. This is for
//      the other two: 'hello@' on a product that may never have set up mail,
//      which no rule can tell from a real founder inbox.
//
// The verdict is written to the contact so each address is judged once.
// Approval and dispatch both call screenContact, and the second call is a
// read. The rules still re-run on a cached verdict, because they are free and
// a rule tightened since should apply to contacts found before it.
//
// Three outcomes, and the third is the one to respect: 'deferred' is not a
// verdict. A timeout, a 500 or a reply that is not the JSON we asked for says
// nothing about the address, so the contact is neither refused nor sent, and
// the next pass asks again.

import { junkReason } from '@probe/core';
import { setContactScreen, type ContactRow, type LeadRow, type ScreenVerdict } from '@probe/db';
import { loadConfig, loadEnv, logger } from '@probe/config';
import { postJson } from '../lib/http';

const log = logger('contact.screen');

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

/** Short on purpose. This runs inside the send loop, and a slow answer is
 *  worth less than the next pass asking again. */
const TIMEOUT_MS = 15_000;

export type ScreenDecision =
  | { decision: 'pass'; verdict: 'person'; reason: string; stage: 'cache' | 'llm' }
  | { decision: 'reject'; verdict: ScreenVerdict; reason: string; stage: 'rules' | 'cache' | 'llm' }
  | { decision: 'deferred'; reason: string };

export interface ScreenInput {
  email: string;
  product_name: string;
  product_domain: string;
  product_url: string;
  product_description: string | null;
  contact_method: string;
  first_name: string | null;
  /** Text found next to the address. Not stored on contacts today, so null
   *  unless a caller has it in hand. */
  context: string | null;
}

export interface ScreenAnswer {
  verdict: ScreenVerdict;
  confidence: number;
  reason: string;
}

type Post = typeof postJson;

export interface ScreenOptions {
  /** Decide without writing anything, not even the verdict. `cli screen
   *  --dry-run`. The model is still asked, so a real run later asks again. */
  dryRun?: boolean;
  /** Injected by tests. */
  post?: Post;
  apiKey?: string | null;
  model?: string;
}

/**
 * 'person' is the only verdict that is mailed.
 *
 * 'shared' is refused even at high confidence. The prompt already counts a
 * small team inbox a founder reads, hello@ on a solo product included, as
 * 'person', so 'shared' is left meaning a departmental inbox at a company big
 * enough to have departments. That address probably exists, but the email is
 * written as one person to another, which is the same reason isRoleAddress
 * refuses support@, and a stranger's support queue is not who it is for.
 *
 * Confidence is recorded in the reason and does not move the line: a model
 * that says 'person' at 0.4 has still not said the address is generated.
 */
export function passes(verdict: ScreenVerdict): boolean {
  return verdict === 'person';
}

export const SYSTEM_PROMPT = [
  'You screen email addresses for a cold outreach tool that writes one short, personal',
  'email to the founder of a newly launched software product. Every address was found',
  'on the product\'s website or a related public page. Your job is to say whether the',
  'address is plausibly a real inbox that the founder reads, using only the address and',
  'the product details given. You cannot check whether it exists; judge plausibility.',
  '',
  'Answer with one JSON object and nothing else:',
  '{"verdict": "person" | "shared" | "junk", "confidence": number from 0 to 1, "reason": short string}',
  '',
  '"person": plausibly a real human\'s inbox, or a small team inbox a founder reads.',
  'A name or initials on the product\'s own domain is person. hello@, hi@, contact@,',
  'team@ or founders@ on a small or solo product is person. A name-like address at a',
  'personal mailbox provider (gmail.com, proton.me, icloud.com) is person.',
  '"shared": a real but departmental inbox at an organisation large enough to have',
  'departments, which the founder is unlikely to read (sales, support desks, partnerships).',
  '"junk": generated or random looking, a placeholder or example, a scraper artefact',
  '(asset names, tokens, tracking ids), an obvious typo, an address on a domain that',
  'does not match the product and has no visible reason to, or anything that looks',
  'unlikely to exist.',
  '',
  'Be strict about junk and lenient about small products: most products here are made',
  'by one or two people, and their only address is often hello@.',
].join('\n');

export function buildScreenInput(contact: ContactRow, lead: LeadRow, context: string | null = null): ScreenInput | null {
  const email = contact.email_norm ?? contact.email;
  if (!email) return null;
  return {
    email,
    product_name: lead.name,
    product_domain: lead.domain,
    product_url: lead.url,
    // A launch blurb is plenty. A long description is tokens, not signal.
    product_description: lead.description ? lead.description.slice(0, 400) : null,
    contact_method: contact.method,
    first_name: contact.first_name,
    context: context ? context.slice(0, 400) : null,
  };
}

/**
 * The model's answer, or null when it is not the JSON we asked for. Tolerates
 * a code fence around the object, since some models add one whatever they are
 * told, and nothing else: a reply we have to guess at is a deferral.
 */
export function parseScreenAnswer(content: string): ScreenAnswer | null {
  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  if (start === -1 || end <= start) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(content.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;

  const verdict = typeof o.verdict === 'string' ? o.verdict.trim().toLowerCase() : '';
  if (verdict !== 'person' && verdict !== 'shared' && verdict !== 'junk') return null;

  const confidence = typeof o.confidence === 'number' ? o.confidence : Number(o.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) return null;

  const reason = typeof o.reason === 'string' ? o.reason.replace(/\s+/g, ' ').trim().slice(0, 300) : '';
  return { verdict, confidence, reason: reason || 'no reason given' };
}

function openRouterKey(): string | undefined {
  try {
    return loadEnv().OPENROUTER_API_KEY;
  } catch {
    return process.env.OPENROUTER_API_KEY || undefined;
  }
}

/** One model call. Never throws: every failure is a string, and the caller
 *  turns a string into a deferral. */
export async function askModel(
  input: ScreenInput,
  opts: { apiKey: string; model: string; post?: Post },
): Promise<ScreenAnswer | string> {
  const post = opts.post ?? postJson;
  const res = await post(
    ENDPOINT,
    JSON.stringify({
      model: opts.model,
      temperature: 0,
      max_tokens: 200,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: JSON.stringify(input) },
      ],
    }),
    {
      timeoutMs: TIMEOUT_MS,
      headers: {
        authorization: `Bearer ${opts.apiKey}`,
        accept: 'application/json',
        'x-title': 'probe',
      },
    },
  );
  if (!res.ok) return `openrouter ${res.status || 'unreachable'}${res.error ? `: ${res.error}` : ''}`;

  let content: unknown;
  try {
    const body = JSON.parse(res.text) as { choices?: Array<{ message?: { content?: unknown } }> };
    content = body.choices?.[0]?.message?.content;
  } catch {
    return 'openrouter returned invalid json';
  }
  if (typeof content !== 'string') return 'openrouter returned no message';

  return parseScreenAnswer(content) ?? 'model did not answer in the requested shape';
}

/**
 * Rules, then the cached verdict, then the model. Writes the verdict unless
 * `dryRun`, and writes nothing for a deferral.
 */
export async function screenContact(
  contact: ContactRow,
  lead: LeadRow,
  opts: ScreenOptions = {},
): Promise<ScreenDecision> {
  const input = buildScreenInput(contact, lead);
  if (!input) {
    // Scrubbed by a suppression (§9.3). The callers check suppression first,
    // so this is a race, and there is nothing left to judge.
    return { decision: 'deferred', reason: 'contact address scrubbed' };
  }

  // Stage 1. Re-run even over a cached verdict: free, and a rule added since
  // the contact was screened should still apply to it.
  const rule = junkReason(input.email);
  if (rule) {
    const reason = `rules: ${rule}`;
    if (!opts.dryRun && (contact.screen_verdict !== 'junk' || contact.screen_reason !== reason)) {
      await setContactScreen(contact.id, { verdict: 'junk', reason });
    }
    return { decision: 'reject', verdict: 'junk', reason, stage: 'rules' };
  }

  if (contact.screen_verdict) {
    const reason = contact.screen_reason ?? 'screened earlier';
    return passes(contact.screen_verdict)
      ? { decision: 'pass', verdict: 'person', reason, stage: 'cache' }
      : { decision: 'reject', verdict: contact.screen_verdict, reason, stage: 'cache' };
  }

  // Stage 2.
  const apiKey = opts.apiKey === undefined ? openRouterKey() : opts.apiKey;
  if (!apiKey) {
    log.warn('screen deferred, OPENROUTER_API_KEY is not set', { lead: lead.domain });
    return { decision: 'deferred', reason: 'OPENROUTER_API_KEY is not set' };
  }
  const model = opts.model ?? loadConfig().global.screen_model;

  const answer = await askModel(input, { apiKey, model, post: opts.post });
  if (typeof answer === 'string') {
    log.warn('screen deferred', { lead: lead.domain, error: answer });
    return { decision: 'deferred', reason: answer };
  }

  const reason = `llm ${answer.confidence.toFixed(2)}: ${answer.reason}`;
  if (!opts.dryRun) await setContactScreen(contact.id, { verdict: answer.verdict, reason });
  log.info('contact screened', {
    lead: lead.domain,
    method: contact.method,
    verdict: answer.verdict,
    confidence: answer.confidence,
  });

  return passes(answer.verdict)
    ? { decision: 'pass', verdict: 'person', reason, stage: 'llm' }
    : { decision: 'reject', verdict: answer.verdict, reason, stage: 'llm' };
}
