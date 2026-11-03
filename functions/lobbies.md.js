// Cloudflare Pages Function: GET /lobbies.md
// The live lobby list as plain Markdown, for AI assistants and other readers that don't
// run JavaScript (the web page builds its table in the browser). Linked from /llms.txt.
import { getLobbiesJson } from '../lib/edge-lobbies.js';

// Same as the page's "Auto" rating: team RM for lobbies with more than two slots, 1v1
// otherwise, falling back to the other ladder.
function lobbyElo(l) {
  const r = l.slots
    .filter((s) => s.kind === 'player')
    .map((s) => (l.maxPlayers > 2 ? s.ratings?.rmTeam ?? s.ratings?.rm1v1 : s.ratings?.rm1v1 ?? s.ratings?.rmTeam))
    .filter((x) => x != null);
  return r.length ? Math.round(r.reduce((a, b) => a + b, 0) / r.length) : null;
}

const cell = (s) => String(s ?? '').replace(/[|\r\n]+/g, ' ').trim() || '–';

function minutesAgo(ms) {
  const m = Math.round((Date.now() - ms) / 60000);
  return m < 1 ? 'just now' : `${m} min ago`;
}

export async function onRequestGet({ request }) {
  const { json, ok } = await getLobbiesJson(request);
  const data = JSON.parse(json);
  const origin = new URL(request.url).origin;
  const lobbies = [...data.lobbies].sort((a, b) => b.firstSeen - a.firstSeen);

  const lines = [
    '# Open Age of Empires II: DE lobbies (live)',
    '',
    `Source: ${origin}/ (AoE2 Lobby Observer), data from the official AoE2 DE game servers.`,
    data.updatedAt ? `Updated: ${new Date(data.updatedAt).toISOString()} · ${lobbies.length} open lobbies.` : 'No data yet.',
    'Join a lobby from a PC with the game installed by opening its join link (aoe2de://0/<lobby id>).',
    'Elo is the average rating of the players in the lobby (team Random Map for team lobbies, 1v1 otherwise).',
    '',
    '| Title | Map | Mode | Players | Elo | Host | Server | Created | Join link |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...lobbies.map((l) => `| ${cell(l.title)}${l.password ? ' 🔒' : ''} | ${cell(l.map)} | ${cell(l.mode)} | ${l.players}/${l.maxPlayers} | ${lobbyElo(l) ?? '–'} | ${cell(l.host)} | ${cell(l.server)} | ${minutesAgo(l.firstSeen)} | aoe2de://0/${l.id} |`),
    '',
    `Machine-readable version with players, civilizations, teams and ratings: ${origin}/api/lobbies`,
  ];

  return new Response(lines.join('\n'), {
    status: ok ? 200 : 503,
    headers: {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Cache-Control': 'public, max-age=15',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
