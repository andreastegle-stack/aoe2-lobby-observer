// Shared by the Cloudflare functions that serve lobby data (/api/lobbies, /lobbies.md).
//
// The free plan allows ~10 ms of CPU per request, and building the lobby list costs most
// of that. So the finished list is shared through Cloudflare's cache: one request per data
// centre rebuilds it every few seconds, every other request just reads it (near-zero CPU).
// A freshly started instance, whose own list is still being built, serves the shared one.
// Uses Cloudflare's cache API, so it only runs on Cloudflare (not in server.js).
import { createLobbyService } from './service.js';

// Never hand out a list older than this; callers answer 503 and the page retries instead.
const MAX_AGE_MS = 30000;
// A shared list younger than this is served as is; older ones trigger a rebuild.
const SHARE_MS = 5000;

// Module scope survives between requests while this worker instance is warm.
const service = createLobbyService();

// Returns { json, ok, source }: ok is false when no list younger than 30 s is available.
export async function getLobbiesJson(request) {
  const cache = caches.default;
  const key = new Request(new URL('/__cache/lobbies-v2', request.url));

  let shared = null;
  let sharedAge = Infinity;
  const hit = await cache.match(key);
  if (hit) {
    sharedAge = Date.now() - Number(hit.headers.get('X-Updated-At'));
    if (sharedAge < SHARE_MS) return { json: await hit.text(), ok: true, source: 'hit' };
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
    return { json, ok: true, source: 'rebuilt' };
  }
  if (shared && sharedAge <= MAX_AGE_MS) return { json: shared, ok: true, source: 'shared' };
  if (ownOk) return { json, ok: true, source: 'own' };
  // Outdated, or a fresh instance still building its list with nothing shared yet.
  return { json, ok: false, source: 'building' };
}
