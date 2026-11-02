// Builds data/maps.json (map string id -> English name) from the game's own string file.
// Usage: node scripts/extract-maps.js [path-to-key-value-strings-utf8.txt]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_PATH =
  'C:/Program Files (x86)/Steam/steamapps/common/AoE2DE/resources/en/strings/key-value/key-value-strings-utf8.txt';

// Map names live in these id ranges (10875 "Arabia", 301151 "Twin Forests", ...).
const RANGES = [
  [10800, 12000],
  [300000, 310000],
];

const src = process.argv[2] || DEFAULT_PATH;
const out = {};
for (const line of fs.readFileSync(src, 'utf8').split(/\r?\n/)) {
  const m = line.match(/^(\d+)\s+"(.*)"\s*$/);
  if (!m) continue;
  const id = Number(m[1]);
  if (RANGES.some(([lo, hi]) => id >= lo && id < hi)) out[id] = m[2];
}

const dest = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'maps.json');
fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.writeFileSync(dest, JSON.stringify(out));
console.log(`Wrote ${Object.keys(out).length} strings to ${dest}`);
