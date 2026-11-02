// Team balance suggestion for 2v2: when a lobby has exactly 4 human players (whatever its
// size), splits them 2 against 2 with the smallest average-rating gap.
// Plain script (no modules) so the page can load it directly; also exposes itself on
// globalThis for testing in Node.
(function () {
  const PLAYERS = 4; // only 2v2 is balanced, 2 players per team
  const MIN_GAMES = 40; // fewer games than this and a ladder rating is not trusted
  const UNRATED = 1000; // stand-in for players with no rating at all
  const LADDERS = ['rm1v1', 'rmTeam'];

  // Average of 1v1 RM and team RM, using only ladders with at least 40 games. If neither
  // qualifies, the ladder with the most games is used and the value is marked unsure.
  function balanceRating(slot) {
    const r = slot.ratings || {};
    const g = slot.games || {};
    const trusted = LADDERS.filter((k) => r[k] != null && (g[k] || 0) >= MIN_GAMES);
    if (trusted.length) {
      return { value: Math.round(trusted.reduce((sum, k) => sum + r[k], 0) / trusted.length), sure: true };
    }
    const any = LADDERS.filter((k) => r[k] != null).sort((a, b) => (g[b] || 0) - (g[a] || 0));
    return { value: any.length ? r[any[0]] : UNRATED, sure: false };
  }

  // The two team numbers players picked most (1 and 2 if nobody picked).
  function teamLabels(players) {
    const counts = {};
    for (const p of players) if (/^[1-4]$/.test(p.team)) counts[p.team] = (counts[p.team] || 0) + 1;
    const labels = Object.keys(counts).sort((a, b) => counts[b] - counts[a] || a - b).slice(0, 2);
    for (const l of ['1', '2', '3', '4']) if (labels.length < 2 && !labels.includes(l)) labels.push(l);
    return labels.sort();
  }

  const avg = (ps) => Math.round(ps.reduce((sum, p) => sum + p.value, 0) / ps.length);

  function suggestBalance(slots) {
    const players = slots.filter((s) => s.kind === 'player')
      .map((s) => ({ name: s.name, team: s.team, ...balanceRating(s) }));
    if (players.length !== PLAYERS) return null;
    const [labelA, labelB] = teamLabels(players);

    let best = null;
    // Player 0 stays on side A, so each of the 3 possible 2v2 splits is tried once; the
    // two ways of numbering the teams are both tried to keep players on teams they picked.
    for (const partner of [1, 2, 3]) {
      const sideA = [0, partner];
      for (const [first, second] of [[labelA, labelB], [labelB, labelA]]) {
        const a = [], b = [], moves = [];
        players.forEach((p, i) => {
          const inA = sideA.includes(i);
          (inA ? a : b).push(p);
          const to = inA ? first : second;
          if (/^[1-4]$/.test(p.team) && p.team !== to) moves.push({ name: p.name, to });
        });
        const diff = Math.abs(avg(a) - avg(b));
        if (!best || diff < best.diff || (diff === best.diff && moves.length < best.moves.length)) {
          const teams = [{ label: first, players: a, avg: avg(a) }, { label: second, players: b, avg: avg(b) }]
            .sort((x, y) => x.label - y.label);
          best = { diff, moves, teams };
        }
      }
    }
    best.alreadyBest = best.moves.length === 0 && players.every((p) => p.team === labelA || p.team === labelB);
    best.unsure = players.some((p) => !p.sure);
    return best;
  }

  globalThis.suggestBalance = suggestBalance;
})();
