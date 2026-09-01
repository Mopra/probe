import { logger } from '@probe/config';
import { addSuppression, getSendByUnsubToken, insertEvent } from '@probe/db';
import { baseUrl } from '../../lib/probe';

export const dynamic = 'force-dynamic';

const log = logger('web:unsubscribe');

/**
 * §9.3. One click, no confirmation page, no login, no JavaScript.
 *
 * This is a route handler rather than a page on purpose: it has to answer both
 * GET (the visible link in the footer) and POST (RFC 8058 one click, sent by
 * the mail client with List-Unsubscribe-Post). A route handler takes both, has
 * no CSRF token to satisfy, and cannot fail on a React render.
 *
 * An unknown or already used token still renders a friendly 200. §4 calls a
 * broken unsubscribe a compliance incident, and a token that was already used
 * has already achieved what the recipient wanted. Nothing here is allowed to
 * return 404 or 500.
 */

async function suppress(token: string): Promise<void> {
  try {
    const send = await getSendByUnsubToken(token);
    if (!send) {
      log.info('unsubscribe for an unknown or spent token', { token_len: token.length });
      return;
    }
    // addSuppression also scrubs contacts.email and contacts.email_norm for
    // that hash, in the same transaction (§9.3).
    await addSuppression({
      email_hash: send.email_hash,
      reason: 'unsubscribed',
      detail: 'one click unsubscribe',
    });
    await insertEvent({ send_id: send.id, type: 'unsubscribe' });
    log.info('unsubscribed', { send_id: send.id, campaign_id: send.campaign_id });
  } catch (err) {
    // Still answer 200. A database problem must never look to the recipient
    // like their opt out was refused, and the suppression can be replayed.
    log.error('unsubscribe failed to record', { error: String(err) });
  }
}

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await ctx.params;
  await suppress(token);
  return html(page());
}

export async function POST(
  _req: Request,
  ctx: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await ctx.params;
  await suppress(token);
  // RFC 8058: the mail client wants a 2xx and nothing else.
  return new Response('Unsubscribed. You will not hear from probe again.\n', {
    status: 200,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function html(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-robots-tag': 'noindex, nofollow',
    },
  });
}

function page(): string {
  const data = `${baseUrl()}/data`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Unsubscribed</title>
<style>
  :root { color-scheme: light dark; --bg:#f7f7f5; --fg:#16181c; --dim:#5c6672; --line:#dcdcd6; --ok:#0f7a68; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#08090b; --fg:#e4e7eb; --dim:#98a1ae; --line:#1e232b; --ok:#31c9ae; }
  }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:16px/1.6 ui-sans-serif,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; }
  main { max-width: 34rem; margin: 0 auto; padding: 4rem 1.5rem; }
  .tag { font:11px/1 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; letter-spacing:.18em; text-transform:uppercase; color:var(--ok); }
  h1 { margin:.75rem 0 1.25rem; font-size:1.75rem; font-weight:400; letter-spacing:-.01em; }
  p { margin:0 0 1rem; color:var(--dim); }
  ul { margin:0 0 1.25rem; padding-left:1.1rem; color:var(--dim); }
  li { margin-bottom:.4rem; }
  hr { border:0; border-top:1px solid var(--line); margin:2rem 0; }
  a { color:inherit; }
  .fine { font-size:.8125rem; }
</style>
</head>
<body>
<main>
  <span class="tag">Done</span>
  <h1>You are unsubscribed.</h1>
  <p>Nothing further is needed. There is no confirmation step and no account to close.</p>
  <ul>
    <li>This is permanent and global. It covers every product we run, not just the one that wrote to you.</li>
    <li>There is no way to resubscribe, by design.</li>
    <li>Your address has been removed from our storage. We keep only a one way hash of it, which is what makes the opt out stick.</li>
  </ul>
  <hr>
  <p class="fine">If you also want the record of where we found your address, or you want it deleted entirely, read the <a href="${escapeAttr(data)}">data notice</a> or reply to the email you received.</p>
</main>
</body>
</html>
`;
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
