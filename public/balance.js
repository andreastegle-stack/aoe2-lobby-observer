// Team balance suggestion for a lobby: splits the human players into two teams with the
// smallest average-rating gap, moving at most 2 players away from each team they picked.
// Plain script (no modules) so the page can load it directly; also exposes itself on
// globalThis for testing in Node.
(function () {
  const MIN_GAMES = 40; // fewer games than this and a ladder rating is not trusted
  const MAX_MOVES_PER_TEAM = 2; // so at most 4 players move, whatever the lobby size
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
    const n = players.length;
    if (n < 4 || n > 8) return null;
    const [labelA, labelB] = teamLabels(players);
    const sizeA = Math.ceil(n / 2);

    let best = null;
    for (let mask = 0; mask < 1 << n; mask++) {
      let size = 0;
      for (let i = 0; i < n; i++) size += (mask >> i) & 1;
      if (size !== sizeA) continue;
      const a = [], b = [], moves = [];
      let leftA = 0, leftB = 0;
      players.forEach((p, i) => {
        const inA = (mask >> i) & 1;
        (inA ? a : b).push(p);
        if (p.team === labelA && !inA) { leftA++; moves.push({ name: p.name, to: labelB }); }
        if (p.team === labelB && inA) { leftB++; moves.push({ name: p.name, to: labelA }); }
      });
      if (leftA > MAX_MOVES_PER_TEAM || leftB > MAX_MOVES_PER_TEAM) continue;
      const diff = Math.abs(avg(a) - avg(b));
      if (!best || diff < best.diff || (diff === best.diff && moves.length < best.moves.length)) {
        best = { diff, moves, teams: [{ label: labelA, players: a, avg: avg(a) }, { label: labelB, players: b, avg: avg(b) }] };
      }
    }
    if (!best) return null;
    best.alreadyBest = best.moves.length === 0 && players.every((p) => p.team === labelA || p.team === labelB);
    best.unsure = players.some((p) => !p.sure);
    return best;
  }

  globalThis.suggestBalance = suggestBalance;
})();
