// Team balance suggestion: splits a lobby's human players (4–8) into two equal teams with
// the smallest average-rating gap, while changing at most 4 players: at most 2 put on each
// team. A player counts as changed when they end up on another team than the one they
// picked, including players who haven't picked a team yet. Everyone else stays put.
// Plain script (no modules) so the page can load it directly; also exposes itself on
// globalThis for testing in Node.
(function () {
  const MAX_CHANGED_PER_TEAM = 2; // so at most 4 players are balanced, whatever the lobby size
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

  // Returns null for lobbies outside 4–8 players, and { impossible: true } when the
  // teams can't be made equal by changing at most 2 players per team.
  function suggestBalance(slots) {
    const players = slots.filter((s) => s.kind === 'player')
      .map((s) => ({ name: s.name, team: s.team, ...balanceRating(s) }));
    const n = players.length;
    if (n < 4 || n > 8) return null;
    const [labelA, labelB] = teamLabels(players);
    const sizeA = Math.ceil(n / 2);

    let best = null;
    for (let mask = 0; mask < 1 << n; mask++) {
      let size = 0;
      for (let i = 0; i < n; i++) size += (mask >> i) & 1;
      if (size !== sizeA) continue;
      // With uneven teams either label may get the bigger side; with even teams both
      // orders are still tried so players stay on the team number they picked.
      for (const [first, second] of [[labelA, labelB], [labelB, labelA]]) {
        const a = [], b = [], moves = [];
        const changedTo = { [first]: 0, [second]: 0 };
        players.forEach((p, i) => {
          const inA = (mask >> i) & 1;
          (inA ? a : b).push(p);
          const to = inA ? first : second;
          if (p.team !== to) { changedTo[to]++; moves.push({ name: p.name, to }); }
        });
        if (changedTo[first] > MAX_CHANGED_PER_TEAM || changedTo[second] > MAX_CHANGED_PER_TEAM) continue;
        const diff = Math.abs(avg(a) - avg(b));
        if (!best || diff < best.diff || (diff === best.diff && moves.length < best.moves.length)) {
          const teams = [{ label: first, players: a, avg: avg(a) }, { label: second, players: b, avg: avg(b) }]
            .sort((x, y) => x.label - y.label);
          best = { diff, moves, teams };
        }
      }
    }
    if (!best) return { impossible: true };
    best.alreadyBest = best.moves.length === 0;
    best.unsure = players.some((p) => !p.sure);
    return best;
  }

  globalThis.suggestBalance = suggestBalance;
})();
