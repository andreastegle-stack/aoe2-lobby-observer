// Cloudflare Pages Function: GET /api/lobbies
import { createLobbyService } from '../../lib/service.js';

// Module scope survives between requests while this worker instance is warm.
const service = createLobbyService();

export async function onRequestGet() {
  return new Response(await service.snapshotJson(), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=4',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
