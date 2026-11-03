// Cloudflare Pages Function: GET /api/lobbies (JSON for the web page and anyone else).
import { getLobbiesJson } from '../../lib/edge-lobbies.js';

export async function onRequestGet({ request }) {
  const { json, ok, source } = await getLobbiesJson(request);
  // 503 when no fresh list is available: the page keeps what it shows and retries.
  return new Response(json, {
    status: ok ? 200 : 503,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
      'X-Lobby-Cache': source,
    },
  });
}
