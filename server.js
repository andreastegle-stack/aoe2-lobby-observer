// Local development server: same lobby data as the Cloudflare deployment, plus the web page.
// Run with `npm run local`. No dependencies beyond Node 20.10+.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLobbyService } from './lib/service.js';

const PORT = Number(process.env.PORT) || 3000;
const service = createLobbyService();
// Keep data fresh between page loads so "Created" times are accurate locally.
setInterval(() => service.snapshot(), 5000);
service.snapshot();

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/api/lobbies') {
    const { json } = await service.snapshot();
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
    res.end(json);
    return;
  }

  // Shareable join/spectate links that open the game, like aoe2lobby.com/j/<id>.
  const join = /^\/(j|w)\/(\d+)$/.exec(url.pathname);
  if (join) {
    res.writeHead(302, { Location: `aoe2de://${join[1] === 'j' ? 0 : 1}/${join[2]}` });
    res.end();
    return;
  }

  const file = path.join(PUBLIC, url.pathname === '/' ? 'index.html' : path.normalize(url.pathname));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(PORT, () => console.log(`Lobby observer running on http://localhost:${PORT}`));
