// Team balance suggestion for lobbies with 4–8 human players.
//
// At most 4 players are balanced, 2 put on each team: a player counts as balanced when
// they are moved to the other team or placed on a team they haven't picked yet. Everyone
// else keeps their current team, and players without a team who aren't placed keep "?".
//
// Who gets balanced is prioritised by how reliable their rating is:
//   tier 1: 40+ games in 1v1 or team RM, tier 2: fewer games, tier 3: no games.
// The suggestion places as many tier-1 players as possible, then tier 2, then tier 3.
// Within that, it places the players with the most effect first: those furthest from the
// lobby's average rating (the highest and lowest), since leaving them on a random team
// skews the game most. Then it picks the smallest average-rating gap, and when that
// ties, prefers moving reliable players and moving fewer players.
//
// Plain script (no modules) so the page can load it directly; also exposes itself on
// globalThis for testing in Node.
(function () {
  const MAX_CHANGED_PER_TEAM = 2; // so at most 4 players are balanced, whatever the lobby size
  const MIN_GAMES = 40; // fewer games than this and a ladder rating is not trusted
  const UNRATED = 1000; // stand-in for players with no rating at all
  const LADDERS = ['rm1v1', 'rmTeam'];

  // Rating used for balancing: the average of 1v1 RM and team RM over ladders with 40+
  // games (tier 1). Otherwise the ladder with the most games (tier 2), or 1000 (tier 3).
  function balanceRating(slot) {
    const r = slot.ratings || {};
    const g = slot.games || {};
    const trusted = LADDERS.filter((k) => r[k] != null && (g[k] || 0) >= MIN_GAMES);
    if (trusted.length) {
      return { value: Math.round(trusted.reduce((sum, k) => sum + r[k], 0) / trusted.length), tier: 1 };
    }
    const any = LADDERS.filter((k) => r[k] != null).sort((a, b) => (g[b] || 0) - (g[a] || 0));
    return any.length ? { value: r[any[0]], tier: 2 } : { value: UNRATED, tier: 3 };
  }

  // The two team numbers players picked most (1 and 2 if nobody picked).
  function teamLabels(players) {
    const counts = {};
    for (const p of players) if (/^[1-4]$/.test(p.team)) counts[p.team] = (counts[p.team] || 0) + 1;
    const labels = Object.keys(counts).sort((a, b) => counts[b] - counts[a] || a - b).slice(0, 2);
    for (const l of ['1', '2', '3', '4']) if (labels.length < 2 && !labels.includes(l)) labels.push(l);
    return labels.sort();
  }

  const avg = (ps) => (ps.length ? Math.round(ps.reduce((sum, p) => sum + p.value, 0) / ps.length) : 0);

  // Lexicographic comparison of score arrays: smaller is better.
  function better(x, y) {
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] < y[i];
    return false;
  }

  // Returns null for lobbies outside 4–8 players, and { impossible: true } when the
  // picked teams are too lopsided to fix by changing at most 2 players per team.
  function suggestBalance(slots) {
    const players = slots.filter((s) => s.kind === 'player')
      .map((s) => ({ name: s.name, team: s.team, ...balanceRating(s) }));
    const n = players.length;
    if (n < 4 || n > 8) return null;
    const labels = teamLabels(players);
    const maxTeamSize = Math.ceil(n / 2);
    const lobbyAvg = avg(players);
    // Where each player can end up: either team, or staying unplaced if they have no team.
    const options = players.map((p) => (labels.includes(p.team) ? labels : [...labels, null]));

    let best = null;
    const choice = new Array(n);
    (function search(i) {
      if (i < n) {
        for (const o of options[i]) { choice[i] = o; search(i + 1); }
        return;
      }
      const teams = { [labels[0]]: [], [labels[1]]: [] };
      const changedTo = { [labels[0]]: 0, [labels[1]]: 0 };
      const unplaced = [], moves = [];
      const unplacedByTier = [0, 0, 0];
      let unplacedEffect = 0; // how far the players left on a random team are from the average
      let movedPriority = 0;
      players.forEach((p, k) => {
        const to = choice[k];
        if (to == null) {
          unplaced.push(p);
          unplacedByTier[p.tier - 1]++;
          unplacedEffect += Math.abs(p.value - lobbyAvg);
          return;
        }
        teams[to].push(p);
        if (p.team !== to) { changedTo[to]++; moves.push({ name: p.name, to }); movedPriority += p.tier; }
      });
      if (changedTo[labels[0]] > MAX_CHANGED_PER_TEAM || changedTo[labels[1]] > MAX_CHANGED_PER_TEAM) return;
      if (teams[labels[0]].length > maxTeamSize || teams[labels[1]].length > maxTeamSize) return;
      if (!teams[labels[0]].length || !teams[labels[1]].length) return;
      const diff = Math.abs(avg(teams[labels[0]]) - avg(teams[labels[1]]));
      const score = [...unplacedByTier, unplacedEffect, diff, movedPriority, moves.length];
      if (!best || better(score, best.score)) {
        best = {
          score, diff, moves, unplaced,
          teams: labels.map((l) => ({ label: l, players: teams[l], avg: avg(teams[l]) })),
        };
      }
    })(0);

    if (!best) return { impossible: true };
    best.alreadyBest = best.moves.length === 0;
    best.unsure = players.some((p) => p.tier > 1);
    return best;
  }

  globalThis.suggestBalance = suggestBalance;
})();
