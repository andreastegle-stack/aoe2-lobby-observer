// Lobby list page: polls /api/lobbies, filters and sorts locally, remembers settings per browser.
const POLL_MS = 5000;
const STORE_KEY = 'lobby-observer-settings';

const DEFAULTS = {
  ladder: 'auto', map: '', minElo: '', maxElo: '', hideFull: false, hidePassword: false,
  hideCustom: false, showHidden: false, sort: 'firstSeen', dir: 'desc', hidden: [],
};

const $ = (id) => document.getElementById(id);
const settings = load();
const expanded = new Set();
let lobbies = [];
let knownIds = null; // ids seen in the previous poll, to highlight new lobbies
let freshIds = new Set();
let updatedAt = null;
let lastError = null;
let pollTimer = null;

function load() {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(STORE_KEY) || '{}') }; }
  catch { return { ...DEFAULTS }; }
}
function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(settings)); } catch { /* private mode */ }
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function ago(ms) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  return `${h} h ${m % 60} min ago`;
}

// "auto" uses team RM for lobbies with more than two slots and 1v1 RM otherwise,
// falling back to the other RM ladder for players who have never played the preferred one.
function playerElo(s, maxPlayers) {
  const r = s.ratings || {};
  if (settings.ladder !== 'auto') return r[settings.ladder] ?? null;
  return maxPlayers > 2 ? r.rmTeam ?? r.rm1v1 ?? null : r.rm1v1 ?? r.rmTeam ?? null;
}

function lobbyElo(l) {
  const r = l.slots.filter((s) => s.kind === 'player').map((s) => playerElo(s, l.maxPlayers)).filter((x) => x != null);
  return r.length ? Math.round(r.reduce((a, b) => a + b, 0) / r.length) : null;
}

function visible() {
  const q = $('search').value.trim().toLowerCase();
  const min = settings.minElo === '' ? null : Number(settings.minElo);
  const max = settings.maxElo === '' ? null : Number(settings.maxElo);
  const hidden = new Set(settings.hidden);
  const rows = lobbies.filter((l) => {
    if (!settings.showHidden && hidden.has(l.id)) return false;
    if (settings.map && l.map !== settings.map) return false; // exact, so "Nomad" excludes "Land Nomad"
    if (settings.hideFull && l.filled >= l.maxPlayers) return false;
    if (settings.hidePassword && l.password) return false;
    if (settings.hideCustom && (l.scenario || l.dataMod)) return false;
    if (min != null || max != null) {
      if (l.elo == null) return false;
      if (min != null && l.elo < min) return false;
      if (max != null && l.elo > max) return false;
    }
    if (q) {
      const hay = [l.title, l.map, l.host, l.mode, l.scenario, l.dataMod, ...l.slots.map((s) => s.name)].join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
  const dir = settings.dir === 'asc' ? 1 : -1;
  const key = settings.sort;
  rows.sort((a, b) => {
    let x = a[key], y = b[key];
    if (x == null && y == null) return 0;
    if (x == null) return 1; // empty values always last
    if (y == null) return -1;
    if (typeof x === 'string') return x.localeCompare(y) * dir;
    return (x - y) * dir;
  });
  return rows;
}

function slotHtml(s) {
  if (s.kind === 'open' || s.kind === 'closed') {
    return `<div class="slot ${s.kind}"><span class="color"></span><span class="who">${s.kind === 'open' ? 'Open' : 'Closed'}</span></div>`;
  }
  // Laid out like the game lobby: player colour on the left, team on the right.
  // Team symbols as in the game: number, "–" for no team, "?" for not chosen yet.
  const color = s.color
    ? `<span class="color c${s.color}" title="Player colour ${s.color}">${s.color}</span>`
    : '<span class="color" title="Colour not chosen">?</span>';
  const team = /^[1-4]$/.test(s.team) ? s.team : s.team === '-' ? '–' : '?';
  const teamTip = team === '–' ? 'No team' : team === '?' ? 'Team not chosen' : `Team ${team}`;
  const teamTag = `<span class="team-tag" title="${teamTip}">${team === '–' ? 'No team' : `Team ${team}`}</span>`;
  const civ = s.civ ? ` <span class="sub" style="display:inline">· ${esc(s.civ)}</span>` : '';
  if (s.kind === 'ai') {
    return `<div class="slot">${color}<span class="who">🤖 AI${civ}</span>${teamTag}</div>`;
  }
  const r = s.ratings || {};
  const tip = `1v1: ${r.rm1v1 ?? 'unrated'}\nTeam game: ${r.rmTeam ?? 'unrated'}`;
  return `<div class="slot">${color}
    <span class="who"><a class="player" href="https://www.aoe2insights.com/user/${s.profileId}/" target="_blank" rel="noopener" data-tip="${esc(tip)}">${esc(s.name)}</a>${civ}</span>${teamTag}</div>`;
}

function balanceHtml(l) {
  const b = suggestBalance(l.slots);
  if (!b) return '';
  if (b.impossible) {
    return `<div class="balance"><div class="balance-head">Balance suggestion</div>
      <div class="sub">The picked teams are too uneven to fix by moving at most 2 players per team.</div></div>`;
  }
  // Tier 1: 40+ games; tier 2: fewer games (marked *); tier 3: no games (shown as unrated).
  const rating = (p) => (p.tier === 3 ? 'unrated' : `${p.value}${p.tier === 2 ? '*' : ''}`);
  const name = (p) => `${esc(p.name)} <span class="sub" style="display:inline">${rating(p)}</span>`;
  const teams = b.teams.map((t) => `<div><b>T${esc(t.label)}:</b> ${t.players.map(name).join(', ')}
    <span class="sub" style="display:inline">· avg ${t.avg}</span></div>`).join('');
  const moves = b.alreadyBest
    ? 'Current teams are already the most even split.'
    : `Moves: ${b.moves.map((m) => `${esc(m.name)} → T${esc(m.to)}`).join(', ')}`;
  const unplaced = b.unplaced.length
    ? `<div class="sub">Not balanced, keep random team: ${b.unplaced.map(name).join(', ')}</div>` : '';
  return `<div class="balance" title="Changes at most 4 players (2 per team). Players with 40+ games are balanced first, then fewer games, then unrated; within that, the highest and lowest rated first.">
    <div class="balance-head">Balance suggestion <span class="sub" style="display:inline">· difference ${b.diff}</span></div>
    ${teams}
    ${unplaced}
    <div class="sub">${moves}</div>
    ${b.unsure ? '<div class="sub">* fewer than 40 games – rating uncertain; unrated players count as 1000</div>' : ''}
    <div><button class="btn small" data-act="copy-balance" data-id="${l.id}">Copy balance suggestion</button></div>
  </div>`;
}

// One line to paste into the game lobby chat, e.g. "T1: A, B (1512) | T2: C, D (1502)".
function balanceText(l) {
  const b = suggestBalance(l.slots);
  return b.teams.map((t) => `T${t.label}: ${t.players.map((p) => p.name).join(', ')} (${t.avg})`).join(' | ');
}

async function copyText(text, label) {
  try { await navigator.clipboard.writeText(text); toast(`${label} copied`); }
  catch { prompt('Copy this:', text); }
}

function detailsHtml(l) {
  const facts = [
    ['Mode', l.mode], ['Map size', l.mapSize], ['Speed', l.speed], ['Population', l.population],
    ['Server', l.server], ['Scenario', l.scenario], ['Mod', l.dataMod],
    ['Spectating', l.observable ? 'allowed' : null],
  ].filter(([, v]) => v != null && v !== '');
  const isHidden = settings.hidden.includes(l.id);
  // Span only the visible columns; hidden ones would otherwise still take width on phones.
  const cols = [...document.querySelectorAll('thead th')].filter((th) => th.offsetParent !== null).length;
  return `<tr class="details"><td colspan="${cols}">
    <div class="facts">${facts.map(([k, v]) => `<span>${k}: <b>${esc(v)}</b></span>`).join('')}</div>
    <div class="slots">${l.slots.map(slotHtml).join('')}</div>
    ${balanceHtml(l)}
    <div style="margin-top:10px">
      <button class="btn small ghost" data-act="copy" data-id="${l.id}">Copy link</button>
      <button class="btn small ghost" data-act="hide" data-id="${l.id}">${isHidden ? 'Unhide' : 'Hide'}</button>
    </div>
  </td></tr>`;
}

function rowHtml(l) {
  const full = l.filled >= l.maxPlayers;
  const isHidden = settings.hidden.includes(l.id);
  const cls = ['lobby', freshIds.has(l.id) ? 'new' : '', isHidden ? 'hidden-lobby' : ''].join(' ');
  const mapSub = l.scenario || l.dataMod;
  return `<tr class="${cls}" data-id="${l.id}" aria-expanded="${expanded.has(l.id)}">
    <td class="num">${l.elo ?? '–'}</td>
    <td class="title" title="${esc(l.title)}">${esc(l.title) || '<i>untitled</i>'}<span class="sub">${esc(l.mode)}</span></td>
    <td class="map" title="${esc(l.map)}">${esc(l.map)}${mapSub ? `<span class="sub">${esc(mapSub)}</span>` : ''}</td>
    <td class="host opt">${esc(l.host)}</td>
    <td class="opt wide">${ago(l.firstSeen)}</td>
    <td class="num ${full ? 'full' : ''}">${l.players}/${l.maxPlayers}</td>
    <td class="icon">${l.password ? '🔒' : ''}</td>
    <td class="actions">
      <a class="btn small" href="aoe2de://0/${l.id}" data-act="join">Join</a>${l.observable ? `<a class="btn small ghost" href="aoe2de://1/${l.id}" data-act="join">Watch</a>` : ''}
      <button class="btn small ghost copy" data-act="copy" data-id="${l.id}" title="Copy join link" aria-label="Copy join link">⧉</button>
      <button class="btn small ghost hide" data-act="hide" data-id="${l.id}" title="${isHidden ? 'Unhide' : 'Hide'} this lobby" aria-label="${isHidden ? 'Unhide' : 'Hide'} this lobby">${isHidden ? '↺' : '✕'}</button>
    </td>
  </tr>${expanded.has(l.id) ? detailsHtml(l) : ''}`;
}

// Map dropdown: every map in the current lobby list with its lobby count, plus the chosen
// map even when no lobby uses it right now. Left alone while open so it doesn't jump.
function renderMapOptions() {
  const sel = $('map-filter');
  sel.classList.toggle('active', !!settings.map);
  if (document.activeElement === sel) return;
  const counts = new Map();
  for (const l of lobbies) counts.set(l.map, (counts.get(l.map) || 0) + 1);
  if (settings.map && !counts.has(settings.map)) counts.set(settings.map, 0);
  const maps = [...counts.keys()].sort((a, b) => a.localeCompare(b));
  sel.innerHTML = `<option value="">All maps</option>` +
    maps.map((m) => `<option value="${esc(m)}">${esc(m)} (${counts.get(m)})</option>`).join('');
  sel.value = settings.map;
}

function render() {
  for (const l of lobbies) l.elo = lobbyElo(l);
  renderMapOptions();
  const rows = visible();
  $('rows').innerHTML = rows.map(rowHtml).join('');
  $('empty').hidden = rows.length > 0;
  for (const th of document.querySelectorAll('th[data-sort]')) {
    th.setAttribute('aria-sort', th.dataset.sort === settings.sort ? (settings.dir === 'asc' ? 'ascending' : 'descending') : 'none');
  }
  renderStatus(rows.length);
}

function renderStatus(shown) {
  const el = $('status');
  el.classList.toggle('live', !lastError && updatedAt != null);
  el.classList.toggle('error', !!lastError);
  if (lastError) $('status-text').textContent = 'Connection problem – retrying…';
  else if (updatedAt) $('status-text').textContent = `${shown} of ${lobbies.length} lobbies · live`;
}

let failures = 0;

async function poll() {
  let delay = POLL_MS;
  try {
    const res = await fetch('/api/lobbies', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    failures = 0;
    const data = await res.json();
    lastError = data.error && !data.updatedAt ? data.error : null;
    const ids = new Set(data.lobbies.map((l) => l.id));
    freshIds = knownIds ? new Set([...ids].filter((id) => !knownIds.has(id))) : new Set();
    knownIds = ids;
    lobbies = data.lobbies;
    updatedAt = data.updatedAt;
    // Forget hidden/expanded lobbies that no longer exist.
    settings.hidden = settings.hidden.filter((id) => ids.has(id));
    for (const id of expanded) if (!ids.has(id)) expanded.delete(id);
    save();
  } catch (e) {
    // Keep showing the current list and retry soon; only report a problem if it persists
    // (the server answers 503 rather than hand out an outdated or half-built list).
    failures++;
    delay = 1500;
    if (failures >= 5) lastError = e.message;
  }
  render();
  // Stop fetching while the tab is in the background; resumes on visibilitychange.
  pollTimer = document.hidden ? null : setTimeout(poll, delay);
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && pollTimer == null) poll();
});

function copyLink(id) {
  // The game's own join link, as used in-game and on Discord.
  return copyText(`aoe2de://0/${id}`, 'Join link');
}

function toast(msg) {
  const t = document.createElement('div');
  t.textContent = msg;
  t.style.cssText = 'position:fixed;bottom:16px;left:50%;transform:translateX(-50%);background:var(--text);color:var(--bg);padding:8px 14px;border-radius:6px;z-index:10';
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 1600);
}

// --- wiring ---
$('rows').addEventListener('click', (e) => {
  const act = e.target.closest('[data-act]');
  if (act) {
    if (act.dataset.act === 'join') return; // let the aoe2de:// link open the game
    e.stopPropagation();
    const id = Number(act.dataset.id);
    if (act.dataset.act === 'copy') copyLink(id);
    if (act.dataset.act === 'copy-balance') {
      const l = lobbies.find((x) => x.id === id);
      if (l) copyText(balanceText(l), 'Balance suggestion');
    }
    if (act.dataset.act === 'hide') {
      const i = settings.hidden.indexOf(id);
      if (i >= 0) settings.hidden.splice(i, 1); else settings.hidden.push(id);
      save(); render();
    }
    return;
  }
  if (e.target.closest('a')) return;
  const row = e.target.closest('tr.lobby');
  if (!row) return;
  const id = Number(row.dataset.id);
  if (expanded.has(id)) expanded.delete(id); else expanded.add(id);
  render();
});

for (const th of document.querySelectorAll('th[data-sort]')) {
  th.addEventListener('click', () => {
    const key = th.dataset.sort;
    if (settings.sort === key) settings.dir = settings.dir === 'asc' ? 'desc' : 'asc';
    else { settings.sort = key; settings.dir = ['title', 'map', 'host', 'mode'].includes(key) ? 'asc' : 'desc'; }
    save(); render();
  });
}

const BINDINGS = [
  ['ladder', 'ladder', 'value'], ['map-filter', 'map', 'value'], ['min-elo', 'minElo', 'value'], ['max-elo', 'maxElo', 'value'],
  ['hide-full', 'hideFull', 'checked'], ['hide-password', 'hidePassword', 'checked'],
  ['hide-custom', 'hideCustom', 'checked'], ['show-hidden', 'showHidden', 'checked'],
];
function syncInputs() {
  for (const [id, key, prop] of BINDINGS) $(id)[prop] = settings[key];
}
for (const [id, key, prop] of BINDINGS) {
  $(id).addEventListener('input', () => { settings[key] = $(id)[prop]; save(); render(); });
}
$('reset-filters').addEventListener('click', () => {
  Object.assign(settings, { ...DEFAULTS, hidden: [] });
  $('search').value = '';
  syncInputs(); save(); render();
});
$('search').addEventListener('input', render);
$('toggle-filters').addEventListener('click', () => {
  const f = $('filters');
  f.hidden = !f.hidden;
  $('toggle-filters').setAttribute('aria-expanded', String(!f.hidden));
});
// Keep the "Created" column ticking between polls.
setInterval(render, 30000);

syncInputs();
poll();
