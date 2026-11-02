// Fetches the official AoE2 DE lobby list on demand, decodes it and adds player ratings.
// State lives in memory: on Cloudflare it survives between requests for as long as the
// worker instance stays warm, so most requests are answered without calling the game API.
import { decodeLobby } from './decode.js';

const API = 'https://aoe-api.worldsedgelink.com/community';
const REFRESH_MS = 5000;
const REFRESH_TIMEOUT_MS = 8000;
const PAGE_SIZE = 100; // the API's maximum per call
const PAGE_STEP = 90; // next page starts a bit early so shifting lists can't skip a lobby
const MAX_PAGES = 6;
const MAX_DECODES = 40; // lobbies decoded per refresh (~1 ms of CPU)
const RATING_TTL_MS = 15 * 60 * 1000;
const RATING_BATCH = 100;

// Leaderboard ids in the official API.
const LADDERS = { 3: 'rm1v1', 4: 'rmTeam', 13: 'ew1v1', 14: 'ewTeam' };

async function getJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  const body = await res.json();
  if (body.result && body.result.code !== 0) throw new Error(`API error: ${body.result.message}`);
  return body;
}

export function createLobbyService() {
  const state = {
    lobbies: [],
    updatedAt: null,
    lastAttempt: 0,
    error: null,
    firstSeen: new Map(), // lobby id -> ms timestamp (the API has no creation time)
    decoded: new Map(), // lobby id -> { key, lobby }, reused while the raw lobby is unchanged
    profiles: new Map(), // profile id -> { alias, country, steamId }
    ratings: new Map(), // profile id -> { fetchedAt, rm1v1, rmTeam, ew1v1, ewTeam }
  };

  async function fetchRatings(ids) {
    for (let i = 0; i < ids.length; i += RATING_BATCH) {
      const batch = ids.slice(i, i + RATING_BATCH);
      const body = await getJson(`${API}/leaderboard/GetPersonalStat?title=age2&profile_ids=${encodeURIComponent(JSON.stringify(batch))}`);
      const byGroup = new Map();
      for (const g of body.statGroups || []) {
        const member = g.members && g.members[0];
        if (g.type === 1 && member) byGroup.set(g.id, member.profile_id);
      }
      const now = Date.now();
      for (const id of batch) state.ratings.set(id, { fetchedAt: now });
      for (const s of body.leaderboardStats || []) {
        const pid = byGroup.get(s.statgroup_id);
        const key = LADDERS[s.leaderboard_id];
        if (pid && key) {
          const r = state.ratings.get(pid);
          r[key] = s.rating;
          r[`${key}Games`] = s.wins + s.losses;
        }
      }
    }
  }

  function withRatings(lobby) {
    for (const slot of lobby.slots) {
      if (slot.kind === 'player') {
        const r = state.ratings.get(slot.profileId) || {};
        slot.ratings = { rm1v1: r.rm1v1 ?? null, rmTeam: r.rmTeam ?? null, ew1v1: r.ew1v1 ?? null, ewTeam: r.ewTeam ?? null };
        slot.games = { rm1v1: r.rm1v1Games ?? 0, rmTeam: r.rmTeamGames ?? 0 };
      }
    }
    return lobby;
  }

  // The API returns at most 100 lobbies per call, so fetch pages until one comes back short.
  // Pages overlap a little because lobbies open and close while we fetch; duplicates are dropped.
  async function fetchAllAdvertisements() {
    const page = (start) => getJson(`${API}/advertisement/findAdvertisements?title=age2&start=${start}&count=${PAGE_SIZE}`);
    const pages = await Promise.all([page(0), page(PAGE_STEP)]); // most of the time two pages cover it
    while (pages.length < MAX_PAGES && (pages[pages.length - 1].matches || []).length === PAGE_SIZE) {
      pages.push(await page(pages.length * PAGE_STEP));
    }
    const matches = new Map();
    const avatars = [];
    for (const p of pages) {
      for (const m of p.matches || []) matches.set(m.id, m);
      avatars.push(...(p.avatars || []));
    }
    return { matches: [...matches.values()], avatars };
  }

  async function refresh() {
    const body = await fetchAllAdvertisements();
    for (const a of body.avatars || []) {
      const steam = /^\/steam\/(\d+)/.exec(a.name || '');
      state.profiles.set(a.profile_id, { alias: a.alias, country: a.country, steamId: steam ? steam[1] : null });
    }
    const now = Date.now();
    // Decoding is the expensive part, so only lobbies that are new or changed get decoded,
    // and at most MAX_DECODES per refresh to stay within Cloudflare's CPU limit. A fresh
    // instance therefore builds its list over a few refreshes; until then it is incomplete.
    const ads = (body.matches || []).filter((ad) => ad.visible === 1);
    let budget = MAX_DECODES;
    state.complete = true;
    const lobbies = [];
    for (const ad of ads) {
      const key = `${ad.options}|${ad.slotinfo}|${ad.maxplayers}|${ad.description}|${ad.passwordprotected}|${ad.isobservable}`;
      const cached = state.decoded.get(ad.id);
      if (cached && (cached.key === key || budget <= 0)) {
        if (cached.key !== key) state.complete = false; // changed, shown as it was for now
        lobbies.push(cached.lobby);
        continue;
      }
      if (budget <= 0) { state.complete = false; continue; }
      budget--;
      try {
        const lobby = decodeLobby(ad, state.profiles);
        state.decoded.set(ad.id, { key, lobby });
        lobbies.push(lobby);
      } catch (e) {
        console.warn(`Could not decode lobby ${ad.id}: ${e.message}`);
      }
    }
    for (const lobby of lobbies) {
      if (!state.firstSeen.has(lobby.id)) state.firstSeen.set(lobby.id, now);
      lobby.firstSeen = state.firstSeen.get(lobby.id);
    }
    const live = new Set(ads.map((ad) => ad.id));
    for (const id of state.firstSeen.keys()) if (!live.has(id)) state.firstSeen.delete(id);
    for (const id of state.decoded.keys()) if (!live.has(id)) state.decoded.delete(id);

    const stale = new Set();
    for (const l of lobbies) for (const s of l.slots) {
      if (s.kind !== 'player') continue;
      const r = state.ratings.get(s.profileId);
      if (!r || now - r.fetchedAt > RATING_TTL_MS) stale.add(s.profileId);
    }
    if (stale.size) await fetchRatings([...stale]).catch((e) => console.warn(`Ratings: ${e.message}`));

    // Keep memory bounded on long-running instances.
    if (state.ratings.size > 20000) state.ratings.clear();
    if (state.profiles.size > 20000) state.profiles.clear();

    state.lobbies = lobbies.map(withRatings);
    state.updatedAt = now;
    state.error = null;
  }

  return {
    // Returns the current lobby list as JSON text plus its age, refreshing it first if it
    // is older than 5 seconds. The text is built once per refresh, not once per visitor.
    // The refresh is awaited (refreshing in the background via waitUntil left some
    // Cloudflare instances serving minutes-old data) and capped so a hung call can't block.
    async snapshot() {
      // A list still being built refreshes on every request so it completes quickly.
      if (Date.now() - state.lastAttempt >= REFRESH_MS || state.complete === false) {
        state.lastAttempt = Date.now();
        let timer;
        const timeout = new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('Game API did not answer in time')), REFRESH_TIMEOUT_MS);
        });
        try {
          await Promise.race([refresh(), timeout]);
        } catch (e) {
          state.error = e.message;
          console.warn(`Refresh failed: ${e.message}`);
        } finally {
          clearTimeout(timer);
        }
        state.json = JSON.stringify({ updatedAt: state.updatedAt, error: state.error, lobbies: state.lobbies });
      }
      return {
        // A request arriving while the very first refresh is still running gets an empty list.
        json: state.json ?? JSON.stringify({ updatedAt: null, error: null, lobbies: [] }),
        ageMs: state.updatedAt ? Date.now() - state.updatedAt : Infinity,
        complete: state.complete !== false,
      };
    },
  };
}
