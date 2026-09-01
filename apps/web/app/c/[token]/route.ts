import { logger } from '@probe/config';
import { isHttps } from '@probe/core';
import { getSendByClickToken, insertEvent } from '@probe/db';
import { baseUrl } from '../../lib/probe';

export const dynamic = 'force-dynamic';

const log = logger('web:click');

/**
 * §8.7. Look up the send by click_token, record the click, 302 to the proof's
 * evidence url. Clicks on the evidence url are the only tracking probe does:
 * no open pixel, because Apple Mail Privacy Protection made that number
 * meaningless and the pixel is a small deliverability negative for nothing.
 *
 * An unknown token redirects to the public base url rather than erroring, and
 * a failed event insert never blocks the redirect. The recipient asked to read
 * a page; our bookkeeping is not their problem.
 */
export async function GET(
  _req: Request,
  ctx: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await ctx.params;
  const fallback = baseUrl() || '/';

  let destination = fallback;
  try {
    const send = await getSendByClickToken(token);
    if (!send) {
      log.info('click on an unknown token', { token_len: token.length });
      return redirect(fallback);
    }

    if (send.evidence_url && isHttps(send.evidence_url)) {
      destination = send.evidence_url;
    } else {
      log.warn('click on a send whose proof has no usable evidence url', { send_id: send.id });
    }

    try {
      await insertEvent({ send_id: send.id, type: 'click', detail: { destination } });
    } catch (err) {
      log.error('click event insert failed, redirecting anyway', {
        send_id: send.id,
        error: String(err),
      });
    }
  } catch (err) {
    log.error('click lookup failed, redirecting to the base url', { error: String(err) });
    return redirect(fallback);
  }

  return redirect(destination);
}

function redirect(location: string): Response {
  return new Response(null, {
    status: 302,
    headers: {
      location,
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
    },
  });
}
