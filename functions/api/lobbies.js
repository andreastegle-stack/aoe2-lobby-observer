// Cloudflare Pages Function: GET /api/lobbies
//
// The free plan allows ~10 ms of CPU per request, and building the lobby list costs most
// of that. So the finished list is shared through Cloudflare's cache: one request per data
// centre rebuilds it every few seconds, every other request just reads it (near-zero CPU).
// A freshly started instance, whose own list is still being built, serves the shared one.
import { createLobbyService } from '../../lib/service.js';

// Never hand out a list older than this; the page keeps what it has and retries instead.
const MAX_AGE_MS = 30000;
// A shared list younger than this is served as is; older ones trigger a rebuild.
const SHARE_MS = 5000;

// Module scope survives between requests while this worker instance is warm.
const service = createLobbyService();

const HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
  'Access-Control-Allow-Origin': '*',
};

const reply = (body, status, source) =>
  new Response(body, { status, headers: { ...HEADERS, 'X-Lobby-Cache': source } });

export async function onRequestGet(context) {
  const cache = caches.default;
  const key = new Request(new URL('/__cache/lobbies-v2', context.request.url));

  let shared = null;
  let sharedAge = Infinity;
  const hit = await cache.match(key);
  if (hit) {
    sharedAge = Date.now() - Number(hit.headers.get('X-Updated-At'));
    if (sharedAge < SHARE_MS) return reply(hit.body, 200, 'hit');
    shared = await hit.text();
  }

  const { json, ageMs, complete } = await service.snapshot();
  const ownOk = complete && ageMs <= MAX_AGE_MS;
  if (ownOk && ageMs < sharedAge) {
    await cache.put(key, new Response(json, {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': `public, max-age=${MAX_AGE_MS / 1000}`,
        'X-Updated-At': String(Date.now() - ageMs),
      },
    }));
    return reply(json, 200, 'rebuilt');
  }
  if (shared && sharedAge <= MAX_AGE_MS) return reply(shared, 200, 'shared');
  if (ownOk) return reply(json, 200, 'own');
  // Outdated, or a fresh instance still building its list with nothing shared yet:
  // the page keeps what it shows and retries.
  return reply(json, 503, 'building');
}
