// Cloudflare Pages Function: GET /api/lobbies
import { createLobbyService } from '../../lib/service.js';

// Never hand out a list older than this; the page keeps what it has and retries instead.
const MAX_AGE_MS = 30000;

// Module scope survives between requests while this worker instance is warm.
const service = createLobbyService();

export async function onRequestGet() {
  const { json, ageMs } = await service.snapshot();
  return new Response(json, {
    status: ageMs > MAX_AGE_MS ? 503 : 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
