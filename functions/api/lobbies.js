// Cloudflare Pages Function: GET /api/lobbies
import { createLobbyService } from '../../lib/service.js';

// Module scope survives between requests while this worker instance is warm.
const service = createLobbyService();

export async function onRequestGet(context) {
  return new Response(await service.snapshotJson((p) => context.waitUntil(p)), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=4',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
