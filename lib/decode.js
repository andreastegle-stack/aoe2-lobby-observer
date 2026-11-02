// Turns a raw "advertisement" from the official AoE2 DE API into a plain lobby object.
// The `options` and `slotinfo` fields are base64 + zlib, and inside that a list of
// length-prefixed "key:value" strings. Key meanings were worked out by comparing
// against known lobbies; unknown values are passed through as numbers.
// Uses only web-standard APIs so it runs both in Node and on Cloudflare.
import MAPS from '../data/maps.json' with { type: 'json' };

const OPT = {
  mapSize: 8, // map width in tiles
  mapStringId: 10,
  customMap: 11, // .rms file name
  gameType: 5,
  scenario: 38,
  speed: 41,
  population: 28,
  dataMod: 63,
};

const GAME_TYPES = {
  0: 'Random Map', 1: 'Regicide', 2: 'Death Match', 3: 'Scenario', 4: 'Campaign',
  5: 'King of the Hill', 6: 'Wonder Race', 7: 'Defend the Wonder', 8: 'Turbo Random Map',
  9: 'Capture the Relic', 10: 'Sudden Death', 11: 'Battle Royale', 13: 'Empire Wars',
  15: 'Co-op Campaign',
};

const MAP_SIZES = {
  120: 'Tiny', 144: 'Small', 168: 'Medium', 200: 'Normal', 220: 'Large',
  240: 'Huge', 255: 'Giant', 480: 'Ludicrous',
};

const SPEEDS = { 0: 'Slow', 1: 'Casual', 2: 'Normal', 3: 'Fast' };

const CIVS = [
  'Hidden', 'Britons', 'Franks', 'Goths', 'Teutons', 'Japanese', 'Chinese', 'Byzantines',
  'Persians', 'Saracens', 'Turks', 'Vikings', 'Mongols', 'Celts', 'Spanish', 'Aztecs', 'Maya',
  'Huns', 'Koreans', 'Italians', 'Hindustanis', 'Inca', 'Magyars', 'Slavs', 'Portuguese',
  'Ethiopians', 'Malians', 'Berbers', 'Khmer', 'Malay', 'Burmese', 'Vietnamese', 'Bulgarians',
  'Tatars', 'Cumans', 'Lithuanians', 'Burgundians', 'Sicilians', 'Poles', 'Bohemians',
  'Dravidians', 'Bengalis', 'Gurjaras', 'Romans', 'Armenians', 'Georgians', 'Achaemenids',
  'Athenians', 'Spartans', 'Shu', 'Wu', 'Wei', 'Jurchens', 'Khitans', 'Mapuche', 'Muisca', 'Tupi',
];

// Slot status in slotinfo: 0 open, 1 closed, 2 AI. A slot with a profile id is a player.
const SLOT_STATUS = { 0: 'open', 1: 'closed', 2: 'ai' };

const utf8 = new TextDecoder();
const b64ToBytes = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function unzipB64(s) {
  const stream = new Blob([b64ToBytes(s)]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Response(stream).text();
}

// Reads the inner "count byte + [uint32 length, bytes]..." list.
function readLengthPrefixed(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const parts = [];
  let i = 1;
  while (i + 4 <= bytes.length) {
    const len = view.getUint32(i, true);
    i += 4;
    parts.push(utf8.decode(bytes.subarray(i, i + len)));
    i += len;
  }
  return parts;
}

function innerB64(quoted) {
  return b64ToBytes(quoted.trim().replace(/^"|"$/g, ''));
}

async function decodeOptions(s) {
  const out = {};
  for (const part of readLengthPrefixed(innerB64(await unzipB64(s)))) {
    const at = part.indexOf(':');
    if (at > 0) out[Number(part.slice(0, at))] = part.slice(at + 1);
  }
  return out;
}

async function decodeSlots(s) {
  const raw = await unzipB64(s);
  const json = raw.slice(raw.indexOf(',') + 1);
  // The JSON array can be followed by trailing bytes, so parse up to its matching bracket.
  let depth = 0, end = 0, inStr = false;
  for (let i = 0; i < json.length; i++) {
    const c = json[i];
    if (inStr) { if (c === '\\') i++; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '[' || c === '{') depth++;
    else if ((c === ']' || c === '}') && --depth === 0) { end = i + 1; break; }
  }
  return JSON.parse(json.slice(0, end)).map((x) => {
    // metaData: ["1", civ, "0", color, "ScenarioPlayerIndex", color, "Team", team].
    // Color is 0-based (0 = blue … 7 = orange); 4294967295 (-1) means not chosen yet.
    let civ = null, team = null, color = null;
    try {
      const md = readLengthPrefixed(innerB64(atob(x.metaData || '')));
      if (md.length > 1) civ = Number(md[1]);
      if (md.length > 3 && Number(md[3]) >= 0 && Number(md[3]) <= 7) color = Number(md[3]) + 1;
      const t = md.indexOf('Team');
      if (t >= 0) team = Number(md[t + 1]);
    } catch { /* empty slot */ }
    return { profileId: x['profileInfo.id'], status: x.status, civ, team, color };
  });
}

function civName(id) {
  if (id == null) return null;
  if (id >= 65536) return 'Random';
  return CIVS[id] || `Civ ${id}`;
}

// Team values: 1 = no team, 2..5 = team 1..4, anything else = random/unset.
function teamLabel(t) {
  if (t === 1) return '-';
  if (t >= 2 && t <= 5) return String(t - 1);
  return '?';
}

function mapName(o) {
  if (o[OPT.customMap]) return o[OPT.customMap].replace(/\.rms$/i, '');
  return MAPS[o[OPT.mapStringId]] || (o[OPT.mapStringId] ? `Map ${o[OPT.mapStringId]}` : 'Unknown');
}

export async function decodeLobby(ad, profiles) {
  const o = await decodeOptions(ad.options);
  let slots = [];
  try { slots = await decodeSlots(ad.slotinfo); } catch { /* keep empty */ }
  slots = slots.slice(0, ad.maxplayers).map((s) => {
    if (s.profileId > 0) {
      const p = profiles.get(s.profileId) || {};
      return {
        kind: 'player', profileId: s.profileId, name: p.alias || String(s.profileId),
        country: p.country || null, steamId: p.steamId || null,
        civ: civName(s.civ), team: teamLabel(s.team), color: s.color,
      };
    }
    const kind = SLOT_STATUS[s.status] || 'open';
    return kind === 'ai'
      ? { kind, civ: civName(s.civ), team: teamLabel(s.team), color: s.color }
      : { kind };
  });
  const gameType = Number(o[OPT.gameType]);
  const host = profiles.get(ad.host_profile_id) || {};
  return {
    id: ad.id,
    title: ad.description,
    hostId: ad.host_profile_id,
    host: host.alias || '',
    map: mapName(o),
    mapSize: MAP_SIZES[o[OPT.mapSize]] || null,
    mode: GAME_TYPES[gameType] || `Mode ${gameType}`,
    scenario: o[OPT.scenario] ? o[OPT.scenario].replace(/\.aoe2scenario$/i, '') : null,
    dataMod: o[OPT.dataMod] || null,
    speed: SPEEDS[o[OPT.speed]] || null,
    population: Number(o[OPT.population]) || null,
    password: ad.passwordprotected === 1,
    observable: ad.isobservable === 1,
    server: ad.relayserver_region,
    maxPlayers: ad.maxplayers,
    players: slots.filter((s) => s.kind === 'player').length,
    filled: slots.filter((s) => s.kind === 'player' || s.kind === 'ai' || s.kind === 'closed').length,
    slots,
  };
}
