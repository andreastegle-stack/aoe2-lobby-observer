// Lobby list page: polls /api/lobbies, filters and sorts locally, remembers settings per browser.
const POLL_MS = 5000;
const STORE_KEY = 'lobby-observer-settings';

const DEFAULTS = {
  ladder: 'auto', minElo: '', maxElo: '', hideFull: false, hidePassword: false,
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
    return `<div class="slot ${s.kind}"><span class="team">·</span><span class="who">${s.kind === 'open' ? 'Open' : 'Closed'}</span></div>`;
  }
  const team = /^[1-4]$/.test(s.team) ? s.team : s.team === '-' ? '–' : '?';
  const civ = s.civ ? ` <span class="sub" style="display:inline">· ${esc(s.civ)}</span>` : '';
  if (s.kind === 'ai') {
    return `<div class="slot"><span class="team t${team}">${team}</span><span class="who">🤖 AI${civ}</span></div>`;
  }
  const r = s.ratings || {};
  const tip = `1v1: ${r.rm1v1 ?? 'unrated'}\nTeam game: ${r.rmTeam ?? 'unrated'}`;
  return `<div class="slot"><span class="team t${team}">${team}</span>
    <span class="who"><a class="player" href="https://www.aoe2insights.com/user/${s.profileId}/" target="_blank" rel="noopener" data-tip="${esc(tip)}">${esc(s.name)}</a>${civ}</span></div>`;
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

function render() {
  for (const l of lobbies) l.elo = lobbyElo(l);
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

async function poll() {
  try {
    const res = await fetch('/api/lobbies', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
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
    lastError = e.message;
  }
  render();
  // Stop fetching while the tab is in the background; resumes on visibilitychange.
  pollTimer = document.hidden ? null : setTimeout(poll, POLL_MS);
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && pollTimer == null) poll();
});

async function copyLink(id) {
  const url = `${location.origin}/j/${id}`;
  try { await navigator.clipboard.writeText(url); toast('Join link copied'); }
  catch { prompt('Copy this join link:', url); }
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
  ['ladder', 'ladder', 'value'], ['min-elo', 'minElo', 'value'], ['max-elo', 'maxElo', 'value'],
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
