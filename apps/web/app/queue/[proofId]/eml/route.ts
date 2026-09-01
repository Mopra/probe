import { logger } from '@probe/config';
import { getQueueItem } from '@probe/db';
import { renderEml } from '../../../lib/render';

export const dynamic = 'force-dynamic';

const log = logger('web:queue:eml');

/**
 * The bytes. Footer applied and evidence url rewritten exactly as the send
 * daemon will do it (§6, §8.7, §9.2.7), assembled by buildMime, so what Morten
 * inspects before approving is the message that actually goes out. The unsub
 * and click tokens are freshly minted for the preview: the real ones are
 * created at approval, and they differ only in their random bytes.
 */
export async function GET(
  _req: Request,
  ctx: { params: Promise<{ proofId: string }> },
): Promise<Response> {
  const { proofId } = await ctx.params;
  const item = await getQueueItem(proofId);

  if (!item) {
    return new Response('No queued proof with that id.\n', {
      status: 404,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }

  let mime: string;
  try {
    mime = renderEml(item);
  } catch (err) {
    log.error('failed to build the raw message', { proof_id: proofId, error: String(err) });
    return new Response(`Could not build the message: ${String(err)}\n`, {
      status: 500,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }

  return new Response(mime, {
    status: 200,
    headers: {
      // text/plain, not message/rfc822: this is for reading in a browser tab,
      // not for handing to a mail client.
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      'x-robots-tag': 'noindex',
    },
  });
}
