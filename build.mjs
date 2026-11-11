// Builds index.html: keeps the page template + bulky snapshot data that is already embedded in index.html,
// overlays the fields maintained in data.json (hand-written text + numbers from update.mjs),
// and refreshes the ESPN-derived blocks (injDates, sch/paAvg, cmp, rosterExtra). Each block is try/catch: on failure the old value stays.
import fs from 'node:fs';
const BASE = 'https://lm-api-reads.fantasy.espn.com/apis/v3/games/fba/seasons/2027';
const L = BASE + '/segments/0/leagues/406470928';
const SITE = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba';
const get = async (u, h) => { const r = await fetch(u, { headers: h || {} }); if (!r.ok) throw new Error(u + ' -> HTTP ' + r.status); return r.json(); };
const r1 = v => v == null || isNaN(v) ? null : Math.round(v * 10) / 10;
const normCdf = z => { const t = 1 / (1 + 0.2316419 * Math.abs(z)), d = 0.3989423 * Math.exp(-z * z / 2);
  const prob = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))); return z > 0 ? 1 - prob : prob; };
const RE = /(<script id="data" type="application\/json">)([\s\S]*?)(<\/script>)/;
let html = fs.readFileSync('v2/index.html', 'utf8');
const A = JSON.parse(html.match(RE)[2]);
const B = JSON.parse(fs.readFileSync('data.json', 'utf8'));
const log = [];
// 1) overlay data.json
const OVER = ['asof', 'league', 'record', 'matchup', 'recap', 'injuries', 'threads', 'roster', 'sched', 'foot', 'stream', 'todo', 'autoAsof', 'version', 'changelog', 'handAsof'];
OVER.forEach(k => { if (B[k] !== undefined) A[k] = B[k]; });
if (B.matchupDays) A.matchupDays = Object.assign({}, A.matchupDays, B.matchupDays);
log.push('overlay');

// 2) ESPN-derived blocks
const meta = await get(L + '?view=mTeam&view=mSettings').catch(e => { log.push('meta FAIL ' + e.message); return null; });
const cal = await get(BASE + '?view=proTeamSchedules_wl').catch(e => { log.push('cal FAIL ' + e.message); return null; });

const md = iso => { const m = String(iso || '').match(/(\d{4})-(\d{2})-(\d{2})/); if (m) return +m[2] + '/' + +m[3];
  const d = new Date(iso); return isNaN(d) ? null : (d.getUTCMonth() + 1) + '/' + d.getUTCDate(); };
try { // injuries with return dates
  const j = await get(SITE + '/injuries'); const out = {};
  (j.injuries || []).forEach(t => (t.injuries || []).forEach(i => {
    const n = i.athlete && i.athlete.displayName; if (!n) return;
    const st = /out/i.test(i.status || '') ? 'OUT' : 'DTD';
    const d = i.details || {}; out[n] = [st, md(d.returnDate) || '', d.type || d.location || ''];
  }));
  if (Object.keys(out).length > 30) { A.injDates = out; log.push('injDates ' + Object.keys(out).length); } else log.push('injDates too few');
} catch (e) { log.push('injDates FAIL ' + e.message); }

try { // schedules + points allowed
  const et = iso => new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'numeric', day: 'numeric' }).format(new Date(iso));
  const sch = {}; let totPA = 0, totG = 0;
  for (let id = 1; id <= 30; id++) {
    const j = await get(SITE + '/teams/' + id + '/schedule');
    const ab = j.team && j.team.abbreviation; if (!ab) continue;
    let pa = 0, n = 0; const up = [];
    (j.events || []).forEach(ev => {
      const c = ev.competitions && ev.competitions[0]; if (!c) return;
      const me = c.competitors.find(x => x.team && x.team.abbreviation === ab) || c.competitors.find(x => x.team && String(x.team.id) === String(id));
      const op = c.competitors.find(x => x !== me); if (!me || !op) return;
      const sc = x => { const s = x.score; return s == null ? null : typeof s === 'object' ? +(s.value != null ? s.value : s.displayValue) : +s; };
      const done = c.status && c.status.type ? c.status.type.completed : (ev.status && ev.status.type && ev.status.type.completed);
      if (done) { const o = sc(op); if (o != null && !isNaN(o)) { pa += o; n++; } }
      else if (up.length < 10) up.push(et(ev.date) + ':' + (me.homeAway === 'away' ? '@' : '') + op.team.abbreviation);
    });
    if (n) { totPA += pa; totG += n; }
    sch[ab] = [n ? Math.round(pa / n) : null, up.join(';'), n ? pa / n : null];
  }
  const avg = totG ? totPA / totG : null;
  if (Object.keys(sch).length >= 28 && avg) { A.paAvg = r1(avg); A.sch = Object.fromEntries(Object.entries(sch).map(([k, v]) => [k, [r1(v[2]), v[1]]])); log.push('sch ' + Object.keys(sch).length + ' paAvg ' + A.paAvg); }
  else log.push('sch too few');
} catch (e) { log.push('sch FAIL ' + e.message); }

let CTX = null, FULLP = null;
try { // cmp: every rostered player + top free agents
  if (!meta || !cal) throw new Error('no meta');
  const abbr = {}, games = {};
  cal.settings.proTeams.forEach(p => { abbr[p.id] = p.abbrev; games[p.id] = p.proGamesByScoringPeriod || {}; });
  const cur = meta.status.currentMatchupPeriod, today = meta.scoringPeriodId;
  const base = today - ((today - 14) % 7 + 7) % 7;  // Monday of this matchup week (period 14 = Mon 11/2)
  const has = (tid, sp) => (games[tid] && (games[tid][String(sp)] || []).length) ? 1 : 0;
  const rest = tid => { let n = 0; for (let sp = today; sp < base + 7; sp++) n += has(tid, sp); return n; };
  const next = tid => { let n = 0; for (let sp = base + 7; sp < base + 14; sp++) n += has(tid, sp); return n; };
  const stat = (p, id) => (p.stats || []).find(x => x.id === id);
  const avgPts = (p, id) => { const s = stat(p, id); return s && s.appliedAverage != null ? r1(s.appliedAverage) : null; };
  const mins = (p, id) => { const s = stat(p, id); const a = s && s.averageStats; const v = a && (a['40'] != null ? a['40'] : a['28']); return v == null ? null : r1(v); };
  const nm = t => t.name || ((t.location || '') + ' ' + (t.nickname || '')).trim();
  const PN = { 1: 'PG', 2: 'SG', 3: 'SF', 4: 'PF', 5: 'C' };
  const posOf = (p, slots) => [0, 1, 2, 3, 4].filter(s => (slots || []).includes(s)).map(s => PN[s + 1]).join('/') || PN[p.defaultPositionId] || '';
  const line = (p, owner, slots) => [p.id, p.fullName, abbr[p.proTeamId], posOf(p, slots || p.eligibleSlots), owner,
    p.injuryStatus === 'OUT' ? 'OUT' : p.injuryStatus === 'DAY_TO_DAY' ? 'DTD' : '',
    avgPts(p, '002027'), avgPts(p, '012027'), avgPts(p, '022027'), avgPts(p, '002026'), mins(p, '012027'), mins(p, '002027'),
    r1(p.ownership && p.ownership.percentOwned), r1(p.ownership && p.ownership.percentChange), rest(p.proTeamId), next(p.proTeamId)].map(v => v == null ? '' : v).join('|');
  const out = []; const mine = {}; const RO = {}, FAL = [];
  for (const t of meta.teams) {
    const j = await get(L + '?view=mRoster&scoringPeriodId=' + today + '&forTeamId=' + t.id);
    const tt = j.teams.find(x => x.id === t.id);
    RO[t.id] = tt.roster.entries.map(e => Object.assign({}, e.playerPoolEntry.player, { slot: e.lineupSlotId }));
    tt.roster.entries.forEach(e => { const p = e.playerPoolEntry.player; p.eligibleSlots = e.playerPoolEntry.player.eligibleSlots || e.eligibleSlots; out.push(line(p, nm(t), p.eligibleSlots));
      if (nm(t) === 'aespa') mine[p.fullName] = { m7: mins(p, '012027'), m27: mins(p, '002027'), inj: p.injuryStatus === 'OUT' ? 'OUT' : p.injuryStatus === 'DAY_TO_DAY' ? 'DTD' : '' }; });
  }
  const filt = { players: { filterStatus: { value: ['FREEAGENT', 'WAIVERS'] }, limit: 200, sortPercOwned: { sortPriority: 1, sortAsc: false }, filterStatsForTopScoringPeriodIds: { value: 5, additionalValue: ['002027', '012027', '022027', '002026'] } } };
  const fa = await get(L + '?view=kona_player_info', { 'x-fantasy-filter': JSON.stringify(filt) });
  (fa.players || []).forEach(x => { const p = x.player || x.playerPoolEntry.player; if (x.onTeamId === 0 || x.status === 'FREEAGENT' || x.status === 'WAIVERS' || x.onTeamId == null) { out.push(line(p, x.status === 'WAIVERS' ? 'Waiver' : 'FA', p.eligibleSlots)); FAL.push(Object.assign({}, p, { own: x.status === 'WAIVERS' ? 'Waiver' : 'FA' })); } });
  CTX = { abbr, games, today, base, has, rest, next, avgPts, mins, posOf, RO, FAL, nm };
  if (out.length > 150) {
    A.cmp = out; log.push('cmp ' + out.length);
    // inj and note are live too: the note used to be hand-written once (e.g. "(11/4 消息)") and never refreshed.
    // It now comes from the injury report update.mjs builds from ESPN each run, minus the "你的 XX。" prefix.
    const injNote = {}; (B.injuries || []).forEach(i => { injNote[i[1]] = String(i[2]).replace(/^你的 [A-Z]+。/, ''); });
    A.rosterExtra = Object.fromEntries(Object.entries(mine).map(([k, v]) => [k, Object.assign({}, (A.rosterExtra || {})[k], { m7: v.m7, m27: v.m27, inj: v.inj, note: injNote[k] || '' })]));
  } else log.push('cmp too few');
} catch (e) { log.push('cmp FAIL ' + e.message); }

let FULL = null; // populated by the decision-data block below; the v2 block reuses it to skip a redundant identical fetch
try { // decision data: best lineup per day, injuries, free-agent hot list, per-day detail
  if (!CTX) throw new Error('no ctx');
  const { abbr, games, today, base, has, rest, next, avgPts, RO, FAL, nm } = CTX;
  const full = await get(L + '?view=mTeam&view=mMatchupScore&view=mSettings');
  FULL = full;
  const cur = full.status.currentMatchupPeriod;
  const meT = full.teams.find(t => nm(t) === 'aespa'); const meId = meT.id;
  const g = full.schedule.find(x => x.matchupPeriodId === cur && x.away && (x.home.teamId === meId || x.away.teamId === meId));
  const meSide = g.home.teamId === meId ? g.home : g.away, opSide = g.home.teamId === meId ? g.away : g.home;
  const opId = opSide.teamId;
  const counts = (full.settings.rosterSettings || {}).lineupSlotCounts || {};
  const SLOTN = { 0: 'PG', 1: 'SG', 2: 'SF', 3: 'PF', 4: 'C', 5: 'G', 6: 'F', 11: 'UTIL' };
  const slots = []; Object.keys(SLOTN).forEach(k => { for (let i = 0; i < (counts[k] || 0); i++) slots.push(+k); });
  const blend = p => { const v = [avgPts(p, '002027'), avgPts(p, '002026'), avgPts(p, '012027')].filter(x => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
  const val = p => { const x = [avgPts(p, '012027'), avgPts(p, '022027'), avgPts(p, '002027'), avgPts(p, '002026')].find(v => v != null); return x == null ? 0 : x; };
  const inj = p => p.injuryStatus === 'OUT' ? 'OUT' : p.injuryStatus === 'DAY_TO_DAY' ? 'DTD' : '';
  const best = (cands) => { // max-weight assignment of players to slots
    const S = slots.length; let dp = new Map([[0, { v: 0, a: [] }]]);
    cands.forEach(c => { const nd = new Map(dp); dp.forEach((st, mask) => { for (let i = 0; i < S; i++) { if (mask & (1 << i)) continue; if (!(c.p.eligibleSlots || []).includes(slots[i])) continue;
      const m2 = mask | (1 << i), v = st.v + c.e; if (!nd.has(m2) || nd.get(m2).v < v) nd.set(m2, { v, a: st.a.concat([[slots[i], c]]) }); } }); dp = nd; });
    let b = { v: 0, a: [] }; dp.forEach(st => { if (st.v > b.v) b = st; }); return b; };
  const dn = ['週一', '週二', '週三', '週四', '週五', '週六', '週日'];
  const dstr = i => { const d = new Date(Date.UTC(2026, 10, 2 + (base - 14) + i)); return (d.getUTCMonth() + 1) + '/' + d.getUTCDate(); };
  const mine = RO[meId].filter(p => p.slot !== 13);
  // (a) best lineup for each remaining day
  const LU = []; let weak = null; let firstEnts = null;
  const tdDone = (() => { const ds = []; Object.keys(games).forEach(t => (games[t][String(today)] || []).forEach(g => ds.push(g.date))); return ds.length > 0 && Math.max(...ds) + 3.5 * 3600000 < Date.now(); })();
  for (let sp = tdDone ? today + 1 : today; sp < base + 7; sp++) {
    const i = sp - base; const jr = await get(L + '?view=mRoster&scoringPeriodId=' + sp + '&forTeamId=' + meId);
    const ents = jr.teams.find(x => x.id === meId).roster.entries.map(e => Object.assign({}, e.playerPoolEntry.player, { slot: e.lineupSlotId }));
    if (!firstEnts) firstEnts = ents;
    const play = ents.filter(p => p.slot !== 13 && has(p.proTeamId, sp)), ok = play.filter(p => p.injuryStatus !== 'OUT');
    const cands = ok.map(p => ({ p, e: blend(p) })).filter(c => c.e != null);
    const curStart = play.filter(p => p.slot < 12 && p.injuryStatus !== 'OUT'); const curSum = curStart.reduce((a, p) => a + (blend(p) || 0), 0);
    const b = best(cands);
    if (sp === today) { const st = ents.filter(p => p.slot < 12).map(blend).filter(x => x != null); weak = st.length ? Math.min(...st) : null; }
    const inNames = new Set(b.a.map(x => x[1].p.fullName)), curNames = new Set(curStart.map(p => p.fullName));
    LU.push({ d: dn[i] + ' ' + dstr(i), cur: r1(curSum), best: r1(b.v), n: ok.length,
      lineup: b.a.map(([s, c]) => [SLOTN[s], c.p.fullName, r1(c.e), inj(c.p)]).sort((x, y) => y[2] - x[2]),
      ins: [...inNames].filter(n => !curNames.has(n)), outs: [...curNames].filter(n => !inNames.has(n)),
      idle: ents.filter(p => p.slot !== 13 && !has(p.proTeamId, sp)).map(p => p.fullName) });
  }
  // (b) injuries on my roster
  const slotNow = {}; (firstEnts || []).forEach(p => slotNow[p.id] = p.slot);
  RO[meId].forEach(p => { if (slotNow[p.id] != null) p.slot = slotNow[p.id]; });
  const INJ = RO[meId].filter(p => p.injuryStatus === 'OUT' || p.injuryStatus === 'DAY_TO_DAY').map(p => [p.fullName, inj(p), p.slot === 13 ? 'IR' : p.slot === 12 ? 'BN' : '先發', r1(blend(p)), rest(p.proTeamId), next(p.proTeamId),
    p.slot === 13 ? '在 IR,回歸前不佔名額' : inj(p) === 'OUT' ? '目前 OUT,先發要換人' : '上場前確認狀態']);
  // (b2) cleared-but-benched: compares this run's injury status per player against last run's
  // (A.injTrack, carried forward in the embedded JSON) to catch someone who was DTD/OUT and is
  // now cleared but still sitting on the bench -- the "早晨第二次更新" alert from CLAUDE.md.
  const prevTrack = A.injTrack || {};
  const clearedBench = RO[meId].filter(p => p.slot === 12 && inj(p) === '' && (prevTrack[p.id] === 'OUT' || prevTrack[p.id] === 'DTD'))
    .map(p => [p.fullName, r1(blend(p))]);
  const newTrack = {}; RO[meId].forEach(p => { newTrack[p.id] = inj(p); }); A.injTrack = newTrack;
  // (c) free-agent hot list
  const hot = FAL.filter(p => p.injuryStatus !== 'OUT' && rest(p.proTeamId) >= 1).map(p => ({ p, e: blend(p), l7: avgPts(p, '012027'), s27: avgPts(p, '002027') }))
    .filter(x => x.e != null && weak != null && ((x.l7 != null && x.s27 != null && x.l7 - x.s27 >= 5) || x.e >= weak - 3) && x.e >= 17).sort((a, b) => b.e - a.e).slice(0, 12)
    .map(x => { const p = x.p, pos = A.cmp.map(l => l.split('|')).find(a => a[0] == p.id); return [p.fullName, abbr[p.proTeamId], p.own, r1(p.ownership && p.ownership.percentOwned), x.s27, x.l7, avgPts(p, '002026'), rest(p.proTeamId), next(p.proTeamId), pos ? pos[3] : '', r1(x.e - weak), inj(p)]; });
  // (c2) this-week opponent streaming watch: who they might drop (bench players with no games
  // left this week) vs who from the FA pool they might grab for tomorrow's slate -- the pattern
  // Leo flagged where an opponent swaps in fresh streamers right after today's games finish.
  const futureGames = tid => { let n = 0; for (let sp = today + 1; sp < base + 7; sp++) n += has(tid, sp); return n; };
  const oppRoster = (RO[opId] || []).filter(p => p.slot !== 13);
  const oppDropCand = oppRoster.filter(p => p.slot === 12 && futureGames(p.proTeamId) === 0)
    .map(p => [p.fullName, abbr[p.proTeamId], r1(blend(p)), inj(p)]).sort((a, b) => (a[2] || 0) - (b[2] || 0));
  const oppPickupCand = FAL.filter(p => p.injuryStatus !== 'OUT' && has(p.proTeamId, today + 1))
    .map(p => ({ p, e: blend(p) })).filter(x => x.e != null && x.e >= 15).sort((a, b) => b.e - a.e).slice(0, 8)
    .map(x => [x.p.fullName, abbr[x.p.proTeamId], r1(x.e), r1(x.p.ownership && x.p.ownership.percentOwned)]);
  // (d) per-day detail (past and current days)
  const dd = { me: {}, op: {} };
  for (let sp = base; sp <= today && sp < base + 7; sp++) {
    const i = sp - base; const jb = await get(L + '?view=mBoxscore&scoringPeriodId=' + sp + '&matchupPeriodId=' + cur);
    const gg = jb.schedule.find(x => x.matchupPeriodId === cur && x.away && (x.home.teamId === meId || x.away.teamId === meId));
    const side = k => gg[k === 'me' ? (gg.home.teamId === meId ? 'home' : 'away') : (gg.home.teamId === meId ? 'away' : 'home')];
    ['me', 'op'].forEach(k => { const sd = side(k); const ents = (sd.rosterForCurrentScoringPeriod || sd.rosterForMatchupPeriod || {}).entries || [];
      const tid = k === 'me' ? meId : opId; const known = {}; (RO[tid] || []).forEach(p => known[p.id] = p);
      const list = ents.map(e => { const p = Object.assign({}, known[e.playerPoolEntry.player.id] || e.playerPoolEntry.player); return { p, slot: e.lineupSlotId, act: e.playerPoolEntry.appliedStatTotal || 0 }; })
        .filter(x => x.slot !== 13 && has(x.p.proTeamId, sp));
      const top = new Set(list.filter(x => x.p.injuryStatus !== 'OUT' || x.slot < 12).map(x => ({ x, v: val(x.p) })).sort((a, b) => b.v - a.v).slice(0, 10).map(o => o.x));
      const rows = [], extra = [];
      list.sort((a, b) => val(b.p) - val(a.p)).forEach(x => { const est = top.has(x) ? r1(val(x.p)) : null;
        if (top.has(x)) rows.push([x.p.fullName, est, r1(x.act), x.slot < 12 ? 'S' : 'B']); else if (x.slot < 12) extra.push([x.p.fullName, null, r1(x.act), 'X']); });
      const pts = (sd.pointsByScoringPeriod || {})[String(sp)];
      dd[k][i] = { rows, extra, est: r1(rows.reduce((a, r) => a + r[1], 0)), act: pts != null ? Math.round(pts) : Math.round(list.filter(x => x.slot < 12).reduce((a, x) => a + x.act, 0)) }; });
  }
  A.dayDetail = dd;

  // (e) next week: opponent analysis + win estimate, computed fresh every run (same roster/schedule
  // data already fetched above for this week's LU/INJ) instead of being a one-time frozen snapshot.
  let OPP = null, WINNEXT = null;
  try {
    const g2 = full.schedule.find(x => x.matchupPeriodId === cur + 1 && x.away && (x.home.teamId === meId || x.away.teamId === meId));
    if (g2) {
      const opId2 = (g2.home.teamId === meId ? g2.away : g2.home).teamId;
      const name2 = nm(full.teams.find(t => t.id === opId2));
      const standings2 = full.teams.map(t => { const o = (t.record || {}).overall || {}; return { id: t.id, name: nm(t), w: o.wins || 0, l: o.losses || 0, pf: o.pointsFor || 0 }; }).sort((a, b) => b.w - a.w || b.pf - a.pf);
      const rank2 = standings2.findIndex(s => s.id === opId2) + 1;
      const rec2 = standings2.find(s => s.id === opId2);
      const teamScore = sd => Object.values(sd.pointsByScoringPeriod || {}).reduce((a, v) => a + (v || 0), 0);
      const hist = [];
      for (let w = Math.max(1, cur - 3); w < cur; w++) {
        const gh = full.schedule.find(x => x.matchupPeriodId === w && x.away && (x.home.teamId === opId2 || x.away.teamId === opId2));
        if (!gh) continue;
        const mine2 = gh.home.teamId === opId2 ? gh.home : gh.away, their = gh.home.teamId === opId2 ? gh.away : gh.home;
        hist.push([w, r1(teamScore(mine2)), r1(teamScore(their))]);
      }
      const PN2 = { 1: 'PG', 2: 'SG', 3: 'SF', 4: 'PF', 5: 'C' };
      const ro2 = (RO[opId2] || []).filter(p => p.slot !== 13);
      const top2 = ro2.map(p => ({ p, e: blend(p) })).filter(c => c.e != null).sort((a, b) => b.e - a.e).slice(0, 6)
        .map(c => [c.p.fullName, abbr[c.p.proTeamId], PN2[c.p.defaultPositionId] || '', r1(c.e), next(c.p.proTeamId), inj(c.p)]);
      const out2 = ro2.filter(p => p.injuryStatus === 'OUT').map(p => p.fullName);
      const games2 = ro2.reduce((a, p) => a + next(p.proTeamId), 0);
      OPP = { name: name2, rec: rec2 ? rec2.w + '-' + rec2.l : '', rank: rank2, pf: rec2 ? Math.round(rec2.pf) : null, games: games2, hist, top: top2, out: out2 };

      const weekEst = (roster, sps) => { const usable = (roster || []).filter(p => p.slot !== 13 && p.injuryStatus !== 'OUT').map(p => ({ p, e: blend(p) })).filter(c => c.e != null);
        let total = 0; sps.forEach(sp => { total += usable.filter(c => has(c.p.proTeamId, sp)).map(c => c.e).sort((a, b) => b - a).slice(0, slots.length).reduce((a, v) => a + v, 0); }); return r1(total); };
      const nextSps = []; for (let sp = base + 7; sp < base + 14; sp++) nextSps.push(sp);
      const meEst = weekEst(RO[meId], nextSps), opEst = weekEst(RO[opId2], nextSps);
      const gm2 = RO[meId].filter(p => p.slot !== 13).reduce((a, p) => a + next(p.proTeamId), 0);
      const sd2 = 13 * Math.sqrt(Math.max(1, gm2 + games2));
      const p2 = Math.max(1, Math.min(99, Math.round(100 * normCdf((meEst - opEst) / (sd2 * Math.SQRT2)))));
      WINNEXT = { opp: name2, meEst, opEst, p: p2 };
    }
  } catch (e) { log.push('next-week opp FAIL ' + e.message); }

  // ---- prediction check (預測檢驗): weekly win estimate + daily lineup estimate vs what happened ----
  // Weekly: the next-week estimate keeps being overwritten until that week starts, so the stored
  // value is the last pre-week call; settled from ESPN's final scores once the week is over.
  // Daily: the estimate is frozen on the day itself (later runs would leak that day's games into
  // the recent averages), and the actual score is filled in once update.mjs marks the day done.
  // Report only -- nothing is auto-adjusted from these yet (too few weeks to fit anything).
  try {
    const PT = A.predTrack || { win: {}, days: {} };
    if (WINNEXT) PT.win[cur + 1] = { opp: WINNEXT.opp, p: WINNEXT.p, meEst: WINNEXT.meEst, opEst: WINNEXT.opEst };
    Object.keys(PT.win).map(Number).filter(mp => mp < cur && !PT.win[mp].res).forEach(mp => {
      const gm = full.schedule.find(x => x.matchupPeriodId === mp && x.away && (x.home.teamId === meId || x.away.teamId === meId)); if (!gm) return;
      const ms = gm.home.teamId === meId ? gm.home : gm.away, os = gm.home.teamId === meId ? gm.away : gm.home;
      if (ms.totalPoints == null || os.totalPoints == null) return;
      PT.win[mp].res = { me: r1(ms.totalPoints), op: r1(os.totalPoints), won: ms.totalPoints > os.totalPoints ? 1 : 0 }; });
    const ti = today - base; if (ti >= 0 && ti < 7 && dd.me[ti] && dd.op[ti] && today > (B.doneSp || 0)) PT.days[today] = Object.assign(PT.days[today] || {}, { d: dstr(ti), me: dd.me[ti].est, op: dd.op[ti].est });
    Object.keys(PT.days).map(Number).filter(sp => sp <= (B.doneSp || 0) && sp >= base && PT.days[sp].meAct == null).forEach(sp => { const i = sp - base;
      if (dd.me[i] && dd.op[i]) { PT.days[sp].meAct = dd.me[i].act; PT.days[sp].opAct = dd.op[i].act; } });
    const wk = Object.keys(PT.win).map(Number).sort((x, y) => x - y).filter(mp => PT.win[mp].res).map(mp => Object.assign({ mp }, PT.win[mp]));
    const dy = Object.keys(PT.days).map(Number).sort((x, y) => x - y).map(sp => PT.days[sp]).filter(d => d.meAct != null);
    const err = []; dy.forEach(d => { err.push([d.me, d.meAct], [d.op, d.opAct]); });
    A.predCheck = {
      win: { n: wk.length, hit: wk.length ? Math.round(100 * wk.filter(w => (w.p >= 50 ? 1 : 0) === w.res.won).length / wk.length) : null,
        brier: wk.length ? Math.round(1000 * wk.reduce((a, w) => a + Math.pow(w.p / 100 - w.res.won, 2), 0) / wk.length) / 1000 : null,
        rows: wk.slice(-6).map(w => [w.mp, w.opp, w.p, w.meEst, w.opEst, w.res.me, w.res.op, w.res.won]) },
      day: { n: dy.length, mae: err.length ? r1(err.reduce((a, e) => a + Math.abs(e[1] - e[0]), 0) / err.length) : null,
        ratio: err.length ? Math.round(100 * err.reduce((a, e) => a + e[1], 0) / Math.max(1, err.reduce((a, e) => a + e[0], 0))) / 100 : null,
        rows: dy.slice(-7).map(d => [d.d, d.me, d.meAct, d.op, d.opAct]) } };
    const keepDays = Object.keys(PT.days).map(Number).sort((x, y) => y - x).slice(0, 120); PT.days = Object.fromEntries(keepDays.map(k => [k, PT.days[k]]));
    A.predTrack = PT;
    log.push('predCheck win ' + wk.length + ' days ' + dy.length + ' pendingToday ' + (PT.days[today] ? 1 : 0));
  } catch (e) { log.push('predCheck FAIL ' + e.message); }
  A.insights = Object.assign({}, A.insights, { LU, INJ, hot, weak: r1(weak), opp: OPP, win: { next: WINNEXT }, clearedBench, oppStream: { drop: oppDropCand, pickup: oppPickupCand } });
  log.push('decision LU ' + LU.length + ' INJ ' + INJ.length + ' hot ' + hot.length + ' dayDetail ' + Object.keys(dd.me).length + ' nextOpp ' + (OPP ? OPP.name : 'none') + ' clearedBench ' + clearedBench.length + ' oppDrop ' + oppDropCand.length + ' oppPickup ' + oppPickupCand.length);
} catch (e) { log.push('decision FAIL ' + e.message); }

try { // v2: full-season matchup schedule + playoff standings context (used by the v2 tab's playoff & future-opponent sections)
  const full2 = FULL || await get(L + '?view=mTeam&view=mMatchupScore&view=mSettings'); // reuse the decision block's fetch of the same view when it's already in hand
  const nm2 = t => t.name || ((t.location || '') + ' ' + (t.nickname || '')).trim();
  const idToName = {}; full2.teams.forEach(t => idToName[t.id] = nm2(t));
  const cur = full2.status.currentMatchupPeriod;
  const ss = full2.settings.scheduleSettings || {};
  const standings = full2.teams.map(t => {
    const o = (t.record || {}).overall || {};
    return { name: nm2(t), w: o.wins || 0, l: o.losses || 0, pf: o.pointsFor || 0, pa: o.pointsAgainst || 0, seed: t.playoffSeed || null, projRank: t.currentProjectedRank || null };
  }).sort((a, b) => b.w - a.w || b.pf - a.pf);
  const wksPlayed = Math.max(cur - 1, 1);
  const avgPF = {}; standings.forEach(s => avgPF[s.name] = s.pf / Math.max(s.w + s.l, wksPlayed));
  const future = {};
  full2.schedule.filter(g => g.matchupPeriodId > cur && g.away).forEach(g => {
    const add = (id, oid) => { const n = idToName[id]; (future[n] = future[n] || []).push({ w: g.matchupPeriodId, opp: idToName[oid] }); };
    add(g.home.teamId, g.away.teamId); add(g.away.teamId, g.home.teamId);
  });
  Object.keys(future).forEach(k => { future[k].sort((a, b) => a.w - b.w); future[k] = future[k].slice(0, 6).map(x => Object.assign({}, x, { sos: r1(avgPF[x.opp]) })); });
  // weekly team score trend for completed weeks, from the same already-fetched schedule (no extra API calls)
  const teamScore = sd => Object.values(sd.pointsByScoringPeriod || {}).reduce((a, v) => a + (v || 0), 0);
  const weeks = []; const scores = {}; full2.teams.forEach(t => { scores[nm2(t)] = []; });
  for (let w = 1; w < cur; w++) {
    const gs = full2.schedule.filter(g => g.matchupPeriodId === w && g.away);
    if (!gs.length) continue;
    weeks.push(w);
    const wk = {};
    gs.forEach(g => { wk[idToName[g.home.teamId]] = r1(teamScore(g.home)); wk[idToName[g.away.teamId]] = r1(teamScore(g.away)); });
    Object.keys(scores).forEach(n => scores[n].push(wk[n] != null ? wk[n] : null));
  }
  const median = weeks.map((w, i) => { const vs = Object.values(scores).map(a => a[i]).filter(v => v != null).sort((a, b) => a - b); return vs.length ? r1(vs[Math.floor(vs.length / 2)]) : null; });
  A.v2 = Object.assign({}, A.v2, { curWeek: cur, regWeeks: ss.matchupPeriodCount || null, playoffTeamCount: ss.playoffTeamCount || null, standings, future, trend: { weeks, scores, median } });
  log.push('v2 standings ' + standings.length + ' future-teams ' + Object.keys(future).length + ' curWeek ' + cur + '/' + ss.matchupPeriodCount + ' playoffTeamCount ' + ss.playoffTeamCount + ' trendWeeks ' + weeks.length);
} catch (e) { log.push('v2 FAIL ' + e.message); }

try { // per-player recent news (latest 3 articles mentioning each player, for the 球員分析 panel)
  if (!CTX) throw new Error('no ctx');
  const j = await get(SITE + '/news?limit=50');
  const arts = j.articles || [];
  const allNames = new Set((A.cmp || []).map(l => l.split('|')[1]));
  const byName = {};
  arts.forEach(a => {
    const link = (a.links && a.links.web && a.links.web.href) || null;
    (a.categories || []).forEach(c => {
      if (c.type !== 'athlete' || !c.description || !allNames.has(c.description)) return;
      (byName[c.description] = byName[c.description] || []).push({ h: a.headline, p: a.published, u: link });
    });
  });
  const NEWS = {};
  Object.keys(byName).forEach(n => { NEWS[n] = byName[n].sort((a, b) => (b.p || '').localeCompare(a.p || '')).slice(0, 3).map(x => ({ h: x.h, d: md(x.p), u: x.u })); });
  A.news = NEWS;
  log.push('news ' + Object.keys(NEWS).length + ' players, from ' + arts.length + ' articles');
} catch (e) { log.push('news FAIL ' + e.message); }

try { // Streaming plan: add a free agent, drop one of mine, compare per-day top-10 totals
  if (!CTX) throw new Error('no ctx');
  const { abbr, today, base, has, avgPts, RO, FAL, nm } = CTX;
  const meId = (meta.teams.find(t => nm(t) === 'aespa') || {}).id;
  const blend = p => { const v = [avgPts(p, '002027'), avgPts(p, '002026'), avgPts(p, '012027')].filter(x => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
  const pool = RO[meId].filter(p => p.slot !== 13 && p.injuryStatus !== 'OUT').map(p => ({ p, e: blend(p) })).filter(x => x.e != null);
  const dayTot = (list, sps) => sps.reduce((a, sp) => a + list.filter(x => has(x.p.proTeamId, sp)).map(x => x.e).sort((x, y) => y - x).slice(0, 10).reduce((u, v) => u + v, 0), 0);
  const cands = FAL.filter(p => p.injuryStatus !== 'OUT').map(p => ({ p, e: blend(p) })).filter(x => x.e != null && x.e >= 15);
  // League rule: at most 4 C-eligible players on a roster (IR included). With 4 already, a C-eligible add
  // may only replace another C-eligible player; this used to suggest e.g. "drop Burries (G), add Sarr (C)".
  const isC = p => (p.eligibleSlots || []).includes(4);
  const C_LIMIT = 4, myC = RO[meId].filter(isC).length;
  const swapOK = (c, o) => !(isC(c.p) && !isC(o.p) && myC >= C_LIMIT);
  const mk = sps => { const b0 = dayTot(pool, sps); const rows = [];
    cands.forEach(c => { const g = sps.filter(sp => has(c.p.proTeamId, sp)).length; if (!g) return; let bestG = 0, bo = null;
      pool.forEach(o => { if (!swapOK(c, o)) return; const nl = pool.filter(x => x !== o).concat([c]); const gain = dayTot(nl, sps) - b0; if (gain > bestG) { bestG = gain; bo = o; } });
      if (bo) rows.push([c.p.fullName, abbr[c.p.proTeamId], c.p.own, r1(c.p.ownership && c.p.ownership.percentOwned), r1(c.e), g, bo.p.fullName, r1(bo.e), sps.filter(sp => has(bo.p.proTeamId, sp)).length, r1(bestG), avgPts(c.p, '002027'), avgPts(c.p, '012027'), avgPts(c.p, '002026')]); });
    return rows.sort((a, b) => b[9] - a[9]).slice(0, 8); };
  const dn = ['週一', '週二', '週三', '週四', '週五', '週六', '週日'];
  const dstr = k => { const d = new Date(Date.UTC(2026, 10, 2 + (base - 14) + k)); return (d.getUTCMonth() + 1) + '/' + d.getUTCDate(); };
  const thisSp = []; for (let sp = today; sp < base + 7; sp++) thisSp.push(sp);
  const nextSp = []; for (let sp = base + 7; sp < base + 14; sp++) nextSp.push(sp);
  const w = [];
  if (thisSp.length) w.push({ label: '本週剩餘(' + thisSp.length + ' 個比賽日:' + dn[thisSp[0] - base] + '到週日)', rows: mk(thisSp) });
  w.push({ label: '下週 ' + dstr(7) + '–' + dstr(13) + '(本週額度已滿時用這份)', rows: mk(nextSp) });
  // The note is rebuilt every run: it used to be a frozen sentence naming a specific player as the one
  // to swap out ("Klay 每次都是最適合換掉的人"), which stayed on the site after that player was gone.
  const outs = {}; w.forEach(x => x.rows.forEach(r => { outs[r[6]] = (outs[r[6]] || 0) + 1; }));
  const topOut = Object.entries(outs).sort((a, b) => b[1] - a[1])[0];
  const note = '增加分數的算法:每天取陣容裡有比賽的球員,依預估場均排出前 10 名加總;把自由市場球員加進來、換掉一位你的球員,比較前後的總分差。預估場均是今年、去年、近 7 場平均的平均(缺哪個就不算哪個)。這裡不看位置限制與上場時間,也假設傷兵不會回來,只能當粗估。每個候選球員都已試過換掉你陣容裡的每一位,表中顯示增加最多的那一個。C 資格最多 4 人:你已有 ' + myC + ' 人' + (myC >= C_LIMIT ? ',所以有 C 資格的球員只會配對換掉你的 C。' : '。') +
    (topOut ? '這次最常被換掉的是 ' + topOut[0] + '(' + topOut[1] + ' 次)。' : '');
  A.streamPlan = Object.assign({}, A.streamPlan, { note, asof: new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hourCycle: 'h23' }) + '(台北時間)', windows: w });
  log.push('streamPlan ' + w.map(x => x.rows.length).join('/'));
} catch (e) { log.push('streamPlan FAIL ' + e.message); }

try { // auto judgments: picks/pickNote/acqNote/sleepers/fridayLineup are rule-based, so they are
  // rebuilt every run instead of being hand-written (saves the daily Claude pass, never goes stale).
  if (!CTX) throw new Error('no ctx');
  const { abbr, today, base, has, rest, next, avgPts, mins, posOf, RO, FAL, nm } = CTX;
  const me = meta.teams.find(t => nm(t) === 'aespa'); const meId = me.id;
  const isC = p => (p.eligibleSlots || []).includes(4);
  const mine = RO[meId], myCs = mine.filter(isC).map(p => p.fullName);
  const W = (A.streamPlan || {}).windows || [];
  const byName = {}; FAL.forEach(p => { byName[p.fullName] = p; });
  // picks: best free agents from the streaming plan (already respects the C limit), unique by name
  const seen = new Set(), picks = [];
  W.forEach(w => w.rows.forEach(r => { if (picks.length >= 4 || seen.has(r[0]) || !byName[r[0]]) return; seen.add(r[0]); const p = byName[r[0]];
    const s27 = avgPts(p, '002027'), l7 = avgPts(p, '012027'), s26 = avgPts(p, '002026');
    picks.push({ name: r[0], pos: posOf(p, p.eligibleSlots) + ' · ' + abbr[p.proTeamId], status: p.own, s27, l7, s26, own: r1(p.ownership && p.ownership.percentOwned),
      games: '本週剩 ' + rest(p.proTeamId) + ' 場', next: next(p.proTeamId), first: picks.length === 0 || undefined,
      why: w.label.replace(/(.*?)(\(.*)/, '$1') + '換掉 ' + r[6] + ' 預估多 ' + r[9] + ' 分。' + (isC(p) ? 'C 資格,只能換掉一個 C。' : '') + (p.own === 'Waiver' ? '在 waiver,要申請、等處理完才會進來。' : '自由球員,加了立刻生效。') }); }));
  A.picks = picks;
  const weakest = mine.filter(p => p.slot !== 13).map(p => [p.fullName, [avgPts(p, '002027'), avgPts(p, '002026'), avgPts(p, '012027')].filter(x => x != null)]).filter(x => x[1].length).map(x => [x[0], r1(x[1].reduce((a, b) => a + b, 0) / x[1].length)]).sort((a, b) => a[1] - b[1])[0];
  A.pickNote = 'C 資格(上限 4 人)目前 ' + myCs.length + ' 人:' + myCs.join('、') + '。' + (myCs.length >= 4 ? '有 C 資格的自由球員只能換掉其中一個。' : '') + (weakest ? '陣容裡預估場均最低的非 IR 球員是 ' + weakest[0] + '(' + weakest[1] + ')。' : '') + '下面的名單依 streaming 試算的增加分數排序,每次更新自動重算。';
  // acqNote: ESPN acquisition settings + this matchup's count + whether I already added today
  const acq = meta.settings.acquisitionSettings || {}, cur = meta.status && meta.status.currentMatchupPeriod;
  const used = ((me.transactionCounter || {}).matchupAcquisitionTotals || {})[String(cur)] || 0;
  let addedToday = null;
  try { const tj = await get(L + '?view=mTransactions2&scoringPeriodId=' + today);
    addedToday = (tj.transactions || []).some(t => t.teamId === meId && t.status === 'EXECUTED' && (t.items || []).some(i => i.type === 'ADD')); } catch (e) {}
  A.acqNote = (acq.matchupLimitPerScoringPeriod ? '這個聯盟每個比賽日最多加 ' + acq.matchupAcquisitionLimit + ' 人' : '本週最多加 ' + acq.matchupAcquisitionLimit + ' 人') + '(ESPN 設定),ESPN 記錄你本週(第 ' + cur + ' 輪)已經加入 ' + used + ' 次。' +
    (addedToday === null ? '' : addedToday ? '今天已經加過人了。' : '今天還沒加人。') + 'Waiver 狀態的球員要申請、等處理;自由球員加了立刻生效。';
  // sleepers: free agents whose last-7 minutes rose 4+ over their season average while their team has someone OUT
  const outBy = {}; Object.values(RO).flat().concat(FAL).forEach(p => { if (p.injuryStatus === 'OUT') { const d = (A.injDates || {})[p.fullName]; (outBy[p.proTeamId] = outBy[p.proTeamId] || []).push(p.fullName + (d && d[1] ? '(' + d[1] + ')' : '')); } });
  const sl = FAL.filter(p => p.injuryStatus !== 'OUT' && outBy[p.proTeamId]).map(p => ({ p, m7: mins(p, '012027'), m27: mins(p, '002027'), l7: avgPts(p, '012027') }))
    .filter(x => x.m7 != null && x.m27 != null && x.m7 - x.m27 >= 4 && (x.l7 || 0) >= 12).sort((a, b) => (b.m7 - b.m27) - (a.m7 - a.m27)).slice(0, 5);
  A.sleepers = { note: '自動整理:自由市場裡近 7 場上場分鐘比今年平均多 4 分鐘以上、近 7 場至少 12 分、而且球隊有主力 OUT 的人。樣本很小,主力回歸後分鐘可能掉回去。',
    rows: sl.map(x => { const p = x.p, s27 = avgPts(p, '002027'), s26 = avgPts(p, '002026');
      return [p.fullName, abbr[p.proTeamId], r1(p.ownership && p.ownership.percentOwned), x.m7, x.m27, x.l7, s27, s26, outBy[p.proTeamId].slice(0, 3).join('、') + ' OUT',
        '分鐘多了 ' + r1(x.m7 - x.m27) + ' 分鐘。' + (s26 == null ? '沒有去年樣本。' : '') + (p.injuryStatus === 'DAY_TO_DAY' ? '本人 DTD。' : '') + (isC(p) ? 'C 資格。' : '')]; }) };
  // fridayLineup (陣容檢查): from the best-lineup check per remaining day
  const LU = (A.insights || {}).LU || [];
  const bad = LU.filter(d => d.best - d.cur > 0.05);
  A.fridayLineup = '陣容檢查(自動):' + (!LU.length ? '沒有取得每日陣容資料。' : bad.length ? bad.map(d => d.d + ' 要換上 ' + (d.ins.join('、') || '—') + '、換下 ' + (d.outs.join('、') || '—')).join(';') + '。' : '本週剩下每一天的先發都已經是最佳排法,不用調整。') +
    (LU[0] ? LU[0].d + ' 有比賽 ' + LU[0].n + ' 人' + (LU[0].idle.length ? ',沒比賽:' + LU[0].idle.join('、') : '') + '。' : '');
  log.push('auto judgments picks ' + picks.length + ' sleepers ' + sl.length + ' C ' + myCs.length);
} catch (e) { log.push('auto judgments FAIL ' + e.message); }

try { // league activity: adds/drops in the last 3 days
  if (!CTX) throw new Error('no ctx');
  const { abbr, today, avgPts, RO, FAL, nm } = CTX;
  const tr = { transactions: [] }; const seen = new Set();
  for (let sp = today - 3; sp <= today + 1; sp++) { const j = await get(L + '?view=mTransactions2&scoringPeriodId=' + sp); (j.transactions || []).forEach(t => { if (!seen.has(t.id)) { seen.add(t.id); tr.transactions.push(t); } }); }
  const teamName = {}; meta.teams.forEach(t => teamName[t.id] = nm(t));
  const since = Date.now() - 3 * 86400000;
  const cnt = {}; (tr.transactions || []).forEach(t => { const k = t.type + '/' + t.status + '/' + (t.processDate ? 'p' : '-') + (t.proposedDate ? 'q' : '-'); cnt[k] = (cnt[k] || 0) + 1; }); log.push('tx kinds ' + JSON.stringify(cnt) + ' keys ' + Object.keys((tr.transactions || [])[0] || {}).join(','));
  const tx = (tr.transactions || []).filter(t => t.status === 'EXECUTED' && (t.type === 'FREEAGENT' || t.type === 'WAIVER') && (t.processDate || t.proposedDate) >= since);
  const ids = new Set(); tx.forEach(t => (t.items || []).forEach(i => ids.add(i.playerId)));
  const known = {}; Object.values(RO).forEach(a => a.forEach(p => known[p.id] = p)); FAL.forEach(p => known[p.id] = p);
  const need = [...ids].filter(i => !known[i]);
  if (need.length) { const f = { players: { filterIds: { value: need }, filterStatsForTopScoringPeriodIds: { value: 5, additionalValue: ['002027', '012027', '022027', '002026'] } } };
    const j = await get(L + '?view=kona_player_info', { 'x-fantasy-filter': JSON.stringify(f) }); (j.players || []).forEach(x => { const p = x.player; known[p.id] = p; }); }
  const blend = p => { const v = [avgPts(p, '002027'), avgPts(p, '002026'), avgPts(p, '012027')].filter(x => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
  const lab = (p, wv) => { const e = blend(p); const fl = [wv ? 'waiver' : null, p.injuryStatus === 'OUT' ? 'OUT' : p.injuryStatus === 'DAY_TO_DAY' ? 'DTD' : null].filter(Boolean); return p.fullName + '(' + (e == null ? '—' : r1(e)) + (fl.length ? ',' + fl.join(',') : '') + ')'; };
  const grp = {};
  tx.sort((a, b) => (b.processDate || b.proposedDate) - (a.processDate || a.proposedDate)).forEach(t => {
    const d = new Date(t.processDate || t.proposedDate); const ds = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric' }).format(d);
    (t.items || []).forEach(i => { const p = known[i.playerId]; if (!p) return; const k = ds + '|' + t.teamId + '|' + (t.id || '') ; const g = grp[k] = grp[k] || { ds, team: teamName[t.teamId], add: [], drop: [] };
      if (i.type === 'ADD') g.add.push(lab(p, t.type === 'WAIVER')); else if (i.type === 'DROP') g.drop.push(lab(p, false)); }); });
  const rows = Object.values(grp).map(g => [g.ds, g.team, [g.add.length ? '撿 ' + g.add.join('、') : '', g.drop.length ? '丟 ' + g.drop.join('、') : ''].filter(Boolean).join(',')]);
  A.activity = Object.assign({}, A.activity, { note: '最近 3 天聯盟內的撿人、丟人(括號是預估每場分數)。資料時間 ' + new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hourCycle: 'h23' }) + '(台北時間)。', rows });
  log.push('activity ' + rows.length + ' (tx ' + tx.length + ')');
} catch (e) { log.push('activity FAIL ' + e.message); }

try { // per-game logs for every rostered player and the top free agents
  if (!CTX) throw new Error('no ctx');
  const { abbr, games, avgPts, RO, FAL, base } = CTX;
  const dd = sp => { const d = new Date(Date.UTC(2026, 10, 2 + (sp - 14))); return (d.getUTCMonth() + 1) + '/' + d.getUTCDate(); };
  const TM = {}; let lgPts = 0, lgPoss = 0, lgFga = 0, lgFta = 0;
  for (let id = 1; id <= 30; id++) { try { const t = await get(SITE + '/teams/' + id + '/statistics'); const ab = (t.team && t.team.abbreviation) || null; const m = {};
    ((t.results && t.results.stats && t.results.stats.categories) || []).forEach(c => (c.stats || []).forEach(x => { m[x.name] = x.value; }));
    if (id === 1) log.push('adv team stat names: ' + Object.keys(m).filter(k => /avg(Field|Free|Turn|Off|Points)|gamesPlayed|Possess/i.test(k)).join(','));
    const fga = m.avgFieldGoalsAttempted, fta = m.avgFreeThrowsAttempted, to = m.avgTurnovers, orb = m.avgOffensiveRebounds, pts = m.avgPoints;
    if (ab && [fga, fta, to, orb, pts].every(v => v != null)) { const poss = fga + 0.44 * fta - orb + to; TM[ab] = { fga, fta, to, poss, pts }; lgPts += pts; lgPoss += poss; lgFga += fga; lgFta += fta; } } catch (e) {} }
  const tmN = Object.keys(TM).length; log.push('adv teams ' + tmN);
  const LGAV = tmN > 20 ? { ts: r1(lgPts / (2 * (lgFga + 0.44 * lgFta)) * 100), usg: 20, per100: r1(lgPts / lgPoss * 100 / 5), poss: r1(lgPoss / tmN) } : null;
  const ADV = {};
  const advOf = (p, ab) => { const g = id => (p.stats || []).find(x => x.id === id); const a27 = g('002027'), a26 = g('002026'); if (!a27 || !a27.stats || !(a27.stats['42'] > 0)) return null;
    const tsOf = st => { if (!st) return null; const d = 2 * (st['14'] + 0.44 * st['16']); return d > 0 ? r1(st['0'] / d * 100) : null; };
    const st = a27.stats, gp = st['42'], mpg = st['40'] / gp, tm = TM[ab]; if (!tm || !mpg) return null;
    const fga = st['14'] / gp, fta = st['16'] / gp, to = st['11'] / gp, pts = st['0'] / gp;
    const usg = 100 * (fga + 0.44 * fta + to) * 48 / (mpg * (tm.fga + 0.44 * tm.fta + tm.to));
    const per100 = pts * 48 * 100 / (mpg * tm.poss);
    return [gp, r1(usg), tsOf(st), r1(per100), tsOf(a26 && a26.stats), a26 && a26.stats ? a26.stats['42'] : null, r1(pts / tm.pts * 100), r1(tm.poss)]; };
  const all = {}; Object.values(RO).forEach(a => a.forEach(p => all[p.id] = p)); FAL.slice(0, 30).forEach(p => all[p.id] = p);
  const ids = Object.keys(all).map(Number); const LG = {};
  // One full-season fetch shared by the game logs here and the teammate splits (mates) below:
  // the top 450 players by roster% plus any rostered/top-FA player outside that group.
  const FULL = {}; const flt = extra => ({ players: Object.assign({ filterStatsForTopScoringPeriodIds: { value: CTX.today + 1, additionalValue: ['002027', '012027', '022027', '002026'] } }, extra) });
  for (let off = 0; off < 450; off += 150) {
    const j = await get(L + '?view=kona_player_info', { 'x-fantasy-filter': JSON.stringify(flt({ limit: 150, offset: off, sortPercOwned: { sortPriority: 1, sortAsc: false } })) });
    (j.players || []).forEach(x => { FULL[x.player.id] = x.player; }); }
  const missIds = ids.filter(id => !FULL[id]);
  for (let k = 0; k < missIds.length; k += 50) {
    const j = await get(L + '?view=kona_player_info', { 'x-fantasy-filter': JSON.stringify(flt({ filterIds: { value: missIds.slice(k, k + 50) } })) });
    (j.players || []).forEach(x => { FULL[x.player.id] = x.player; }); }
  FULLP = FULL; log.push('full pool ' + Object.keys(FULL).length + ' (extra ' + missIds.length + ')');
  // every pooled player gets a log so the site search can open anyone in the top 450, not just rostered + top FA
  Array.from(new Set(ids.concat(Object.keys(FULL).map(Number)))).map(id => FULL[id]).filter(Boolean).forEach(p => { const base0 = all[p.id] || p;
      const gl = (p.stats || []).filter(s => s.statSplitTypeId === 5 && s.seasonId === 2027 && s.stats && s.stats['40'] != null && s.stats['40'] > 0).sort((a, b) => b.scoringPeriodId - a.scoringPeriodId).slice(0, 10).map(s => {
        const gm = ((games[s.proTeamId] || {})[String(s.scoringPeriodId)] || [])[0]; const opp = gm ? (gm.homeProTeamId === s.proTeamId ? 'vs ' + abbr[gm.awayProTeamId] : '@ ' + abbr[gm.homeProTeamId]) : '';
        const v = i => s.stats[String(i)] == null ? 0 : Math.round(s.stats[String(i)]);
        return [dd(s.scoringPeriodId), opp, r1(s.appliedTotal), v(0), v(6), v(3), v(2), v(1), v(11), v(40)]; });
      try { const ad = advOf(p, abbr[p.proTeamId]); if (ad) ADV[p.id] = ad; } catch (e) {}
      LG[p.id] = [p.fullName, abbr[p.proTeamId], avgPts(p, '002027'), avgPts(p, '012027'), avgPts(p, '022027'), avgPts(p, '002026'), r1((base0.ownership || p.ownership || {}).percentOwned), p.injuryStatus || null, gl]; });
  // roleAlerts: your own players whose last-3-game minutes moved 5+ from the rest of their season
  // (needs 6+ games) -- role changes show up in minutes before they show up in the averages.
  try {
    const myIds = (A.cmp || []).map(l => l.split('|')).filter(a => a[4] === 'aespa').map(a => +a[0]);
    A.roleAlerts = myIds.map(id => FULL[id]).filter(Boolean).map(p => {
      const g = (p.stats || []).filter(s => s.statSplitTypeId === 5 && s.seasonId === 2027 && s.stats && s.stats['40'] > 0).sort((a, b) => b.scoringPeriodId - a.scoringPeriodId);
      if (g.length < 6) return null; const av = (a, f) => a.reduce((x, y) => x + f(y), 0) / a.length;
      const l3 = g.slice(0, 3), rest = g.slice(3), m3 = av(l3, s => s.stats['40']), mr = av(rest, s => s.stats['40']);
      if (Math.abs(m3 - mr) < 5) return null;
      return [p.fullName, abbr[p.proTeamId], r1(m3), r1(mr), r1(av(l3, s => s.appliedTotal || 0)), r1(av(rest, s => s.appliedTotal || 0)), rest.length];
    }).filter(Boolean).sort((a, b) => (a[2] - a[3]) - (b[2] - b[3]));
    log.push('roleAlerts ' + A.roleAlerts.length);
  } catch (e) { log.push('roleAlerts FAIL ' + e.message); }
  if (LGAV && Object.keys(ADV).length > 50) { A.adv = ADV; A.advLg = LGAV; log.push('adv ' + Object.keys(ADV).length + ' lg ' + JSON.stringify(LGAV)); } else log.push('adv too few ' + Object.keys(ADV).length);
  if (Object.keys(LG).length > 100) { A.logs = LG; log.push('logs ' + Object.keys(LG).length + ' sample games ' + JSON.stringify(Object.values(LG)[0][8].slice(0, 2))); } else log.push('logs too few');

  // ---------- daily burst/bust leaderboard + weekly tally ----------
  // Reuses the per-player game logs just built above (no extra API calls). For the day that
  // just finished (B.doneSp, set by update.mjs), compares each player's actual fantasy score
  // to their own expected baseline (season avg, falling back to last year / last-15 when the
  // season sample is thin) and ranks the biggest positive/negative gaps. Only players with an
  // expected baseline >= 10 count, so a garbage-time bench stat line can't swing the list.
  // Also keeps a running weekly tally (reset when the matchup week's Monday scoring period
  // changes) to auto-write a one-line comment on anyone who keeps showing up either way.
  try {
    const dayLabel = dd(B.doneSp);
    const rows = [];
    Object.keys(all).forEach(id => {
      const p = all[id], L0 = LG[id]; if (!L0) return;
      const gl = L0[8]; if (!gl || !gl.length) return;
      const g0 = gl[0]; if (g0[0] !== dayLabel) return; // only the day that just finished
      const [, opp, score, pts, reb, ast, stl, blk, to] = g0;
      const s27 = L0[2], l15 = L0[4], s26 = L0[5];
      const exp = s27 != null ? s27 : (s26 != null ? s26 : l15);
      if (exp == null || exp < 10) return;
      rows.push({ id: +id, name: p.fullName, team: abbr[p.proTeamId], opp, score, exp: r1(exp), diff: r1(score - exp), pts, reb, ast, stl, blk, to, own: L0[6] });
    });
    rows.sort((a, b) => b.diff - a.diff);
    const up = rows.filter(r => r.diff > 0).slice(0, 10);
    const down = rows.filter(r => r.diff < 0).sort((a, b) => a.diff - b.diff).slice(0, 10);
    // 週報(points raised by Leo): when the matchup week turns over (base changes), freeze a
    // summary of the week that just ended -- final score (from B.lastWeekResult, captured by
    // update.mjs right before it overwrote D.matchup for the new week) plus the top burst/bust
    // players from that week's tally (A.burstWeek, about to be reset below) -- something
    // concrete to look back on when planning next week's roster moves.
    if (A.burstWeek && A.burstWeek.base !== base && B.lastWeekResult) {
      const oldTally = Object.values(A.burstWeek.tally || {});
      const topUp = oldTally.filter(t => t.up > 0).sort((a, b) => b.up - a.up || b.best - a.best).slice(0, 5).map(t => [t.name, t.up, r1(t.best)]);
      const topDown = oldTally.filter(t => t.down > 0).sort((a, b) => b.down - a.down || a.worst - b.worst).slice(0, 5).map(t => [t.name, t.down, r1(t.worst)]);
      const W = B.lastWeekResult;
      A.weekReport = { opp: W.opp, meScore: W.meScore, oppScore: W.oppScore, result: W.meScore >= W.oppScore ? '勝' : '敗', burstTop: topUp, bustTop: topDown };
      log.push('weekReport opp ' + W.opp + ' result ' + A.weekReport.result);
    }
    // A week can see several build runs that all land on the same completed day (the normal
    // 4-hour slot, a transaction-triggered run, a manual dispatch) -- tally only once per
    // calendar day (lastDay), not once per build run, or a busy day would get double/triple
    // counted toward the weekly total below.
    const prevWeek = (A.burstWeek && A.burstWeek.base === base) ? A.burstWeek : { base, tally: {}, lastDay: null };
    const tally = prevWeek.tally;
    if (prevWeek.lastDay !== dayLabel) {
      const bump = (r, dir) => { const t = tally[r.id] = tally[r.id] || { name: r.name, up: 0, down: 0, best: 0, worst: 0 };
        if (dir > 0) { t.up++; t.best = Math.max(t.best, r.diff); } else { t.down++; t.worst = Math.min(t.worst || 0, r.diff); } };
      up.forEach(r => bump(r, 1)); down.forEach(r => bump(r, -1));
    }
    const notable = Object.values(tally).filter(t => t.up >= 2 || t.down >= 2).sort((a, b) => (b.up - b.down) - (a.up - a.down));
    const weekComment = notable.slice(0, 4).map(t => t.up >= 2 && t.up > t.down
      ? t.name + ' 本週已 ' + t.up + ' 次登上爆走榜(單場最高 +' + r1(t.best) + ')'
      : t.down >= 2 && t.down > t.up
        ? t.name + ' 本週已 ' + t.down + ' 次爆胎(單場最差 ' + r1(t.worst) + ')'
        : t.name + ' 本週忽冷忽熱,爆走 ' + t.up + ' 次、爆胎 ' + t.down + ' 次').join(';');
    A.burstWeek = { base, tally, lastDay: dayLabel };
    A.burst = { day: dayLabel, up, down, weekComment: weekComment || null };
    log.push('burst up ' + up.length + ' down ' + down.length + ' weekTally ' + Object.keys(tally).length);
  } catch (e) { log.push('burst FAIL ' + e.message); }
} catch (e) { log.push('logs FAIL ' + e.message); }

try { // playoffSched: how many NBA games each team (and each of your players) has in each fantasy playoff round
  // Rounds come from ESPN's scheduleSettings.matchupPeriods (keys past the regular-season count; a
  // round can span 2 weeks). Week w starts on the Monday scoring period base + 7 * (w - current week).
  if (!CTX || !meta) throw new Error('no ctx');
  const { abbr, games, base, has } = CTX; const ss = meta.settings.scheduleSettings, cur = meta.status.currentMatchupPeriod;
  const dd = sp => { const d = new Date(Date.UTC(2026, 10, 2 + (sp - 14))); return (d.getUTCMonth() + 1) + '/' + d.getUTCDate(); };
  const rounds = Object.keys(ss.matchupPeriods).map(Number).filter(k => k > ss.matchupPeriodCount).sort((x, y) => x - y).map((k, i) => {
    const wks = ss.matchupPeriods[k], sps = []; wks.forEach(w => { for (let d = 0; d < 7; d++) sps.push(base + 7 * (w - cur) + d); });
    return { label: '第 ' + (i + 1) + ' 輪', weeks: wks, from: dd(sps[0]), to: dd(sps[sps.length - 1]), sps }; });
  const T = {}; Object.keys(abbr).forEach(tid => { if (!abbr[tid] || abbr[tid] === 'FA') return; T[abbr[tid]] = rounds.map(r => r.sps.reduce((n, sp) => n + has(+tid, sp), 0)); });
  const vals = Object.values(T); if (vals.length < 25 || !vals.some(v => v.some(x => x > 0))) throw new Error('no playoff games in schedule');
  const avg = rounds.map((r, i) => r1(vals.reduce((a, v) => a + v[i], 0) / vals.length));
  const mine = (A.cmp || []).map(l => l.split('|')).filter(x => x[4] === 'aespa').map(x => { const t = T[x[2]] || rounds.map(() => 0);
    const est = [x[6], x[9]].filter(v => v !== '').map(Number); return [x[1], x[2], ...t, t.reduce((a, b) => a + b, 0), est.length ? r1(est.reduce((a, b) => a + b, 0) / est.length) : null, x[5]]; })
    .sort((p, q) => q[q.length - 3] - p[p.length - 3]);
  A.playoffSched = { rounds: rounds.map(r => [r.label, r.from, r.to, r.weeks.length]), avg, teams: T, mine };
  log.push('playoffSched rounds ' + rounds.length + ' avg ' + avg.join('/'));
} catch (e) { log.push('playoffSched FAIL ' + e.message); }

try { // tradeIdeas: 1-for-1 swaps where you send depth at a position you are strong in and get back a
  // similar-value player at your weakest position, from a team that is weak where you are strong.
  // Value = mean of this season and last season fantasy avg (same as the rest of the site). Position
  // strength = value of the 2nd-best non-IR player eligible there, compared with the league average.
  // Skips injured (OUT) players, your top 3, and any swap that breaks the 4-C limit on either side.
  if (!CTX || !meta) throw new Error('no ctx');
  const { RO, abbr, nm, posOf } = CTX; const POS = ['PG', 'SG', 'SF', 'PF', 'C'];
  const val = p => { const v = [CTX.avgPts(p, '002027'), CTX.avgPts(p, '002026')].filter(x => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
  const teams = meta.teams.map(t => ({ id: t.id, name: nm(t), ro: (RO[t.id] || []).filter(p => p.slot !== 13).map(p => ({ p, v: val(p), pos: posOf(p, p.eligibleSlots).split('/').filter(Boolean), c: (p.eligibleSlots || []).includes(4) })).filter(x => x.v != null) }));
  const str = t => { const o = {}; POS.forEach(ps => { const v = t.ro.filter(x => x.pos.includes(ps)).map(x => x.v).sort((a, b) => b - a); o[ps] = v[1] != null ? v[1] : (v[0] || 0) / 2; }); return o; };
  teams.forEach(t => { t.s = str(t); });
  const lg = {}; POS.forEach(ps => { lg[ps] = teams.reduce((a, t) => a + t.s[ps], 0) / teams.length; });
  const need = t => { const o = {}; POS.forEach(ps => { o[ps] = lg[ps] - t.s[ps]; }); return o; };
  const me = teams.find(t => t.name === 'aespa'); if (!me) throw new Error('no me');
  // for you, 'need' is relative to your own average position strength: a contender is above the
  // league average everywhere, so its holes are the positions it is weakest at compared with itself
  const myAvg = POS.reduce((a, ps) => a + me.s[ps], 0) / POS.length, myN = {}; POS.forEach(ps => { myN[ps] = myAvg - me.s[ps]; });
  const myTop = new Set(me.ro.slice().sort((a, b) => b.v - a.v).slice(0, 3).map(x => x.p.id));
  const myC = me.ro.filter(x => x.c).length;
  const PO = (A.playoffSched || {}).teams || {}, poOf = p => (PO[abbr[p.proTeamId]] || []).reduce((a, b) => a + b, 0);
  const fit = (n, pos) => Math.max(0, ...pos.map(ps => n[ps]));
  const ideas = [];
  teams.filter(t => t !== me).forEach(t => { const thN = need(t), thC = t.ro.filter(x => x.c).length;
    me.ro.filter(x => !myTop.has(x.p.id) && x.p.injuryStatus !== 'OUT' && x.v >= 18).forEach(A0 => t.ro.filter(x => x.p.injuryStatus !== 'OUT').forEach(B0 => {
      if (B0.v < A0.v - 1 || B0.v > A0.v + 4) return;                      // roughly fair, never a clear downgrade for you
      if (myC - (A0.c ? 1 : 0) + (B0.c ? 1 : 0) > 4 || thC - (B0.c ? 1 : 0) + (A0.c ? 1 : 0) > 4) return;
      const mine = fit(myN, B0.pos) - fit(myN, A0.pos), theirs = fit(thN, A0.pos) - fit(thN, B0.pos);
      if (mine <= 1 || theirs <= 1) return;                                 // both sides must fill a real hole
      const po = poOf(B0.p) - poOf(A0.p);
      ideas.push({ team: t.name, give: A0, get: B0, mine: r1(mine), theirs: r1(theirs), po, score: (B0.v - A0.v) + 0.5 * mine + 0.3 * theirs + 0.5 * po });
    })); });
  ideas.sort((a, b) => b.score - a.score);
  const per = {}, pick = []; ideas.forEach(x => { if (pick.length >= 5 || (per[x.team] || 0) >= 2 || pick.some(y => y.get.p.id === x.get.p.id || y.give.p.id === x.give.p.id)) return; per[x.team] = (per[x.team] || 0) + 1; pick.push(x); });
  const weak = POS.filter(ps => myN[ps] > 1).sort((a, b) => myN[b] - myN[a]);
  const weakAvg = r1(myAvg);
  A.tradeIdeas = { myAvg: weakAvg, weak: weak.map(ps => [ps, r1(me.s[ps]), r1(lg[ps])]), rows: pick.map(x => [x.team, x.give.p.fullName, abbr[x.give.p.proTeamId], x.give.pos.join('/'), r1(x.give.v), x.get.p.fullName, abbr[x.get.p.proTeamId], x.get.pos.join('/'), r1(x.get.v), x.mine, x.theirs, x.po]) };
  log.push('tradeIdeas ' + pick.length + ' (of ' + ideas.length + ') weak ' + weak.join(','));
} catch (e) { log.push('tradeIdeas FAIL ' + e.message); }

try { // mates: how a player's fantasy score moves when a key teammate sits (player modal "隊友影響")
  // Key teammates = the top 5 by minutes per game on each NBA team (this season, or last season
  // when the player has fewer than 3 games -- catches stars hurt since opening night). For every
  // player in A.logs, split his games this season by whether each key teammate played, and keep
  // the split only when the teammate is OUT right now (score should rise while he sits) or came
  // back within the last 7 days (score may drop). Needs >= 3 games on each side and a >= 3 point gap.
  if (!CTX || !A.logs) throw new Error('no ctx/logs');
  const { abbr, games, today } = CTX;
  const dd = sp => { const d = new Date(Date.UTC(2026, 10, 2 + (sp - 14))); return (d.getUTCMonth() + 1) + '/' + d.getUTCDate(); };
  if (!FULLP) throw new Error('no full pool'); const POOL = FULLP;
  const played = p => { const m = {}; (p.stats || []).forEach(s => { if (s.statSplitTypeId === 5 && s.seasonId === 2027 && s.stats && s.stats['40'] > 0) m[s.scoringPeriodId] = s; }); return m; };
  const mpg = (p, id) => { const s = (p.stats || []).find(x => x.id === id); const gp = s && s.stats && s.stats['42']; return gp ? { gp, m: s.stats['40'] / gp } : { gp: 0, m: 0 }; };
  const byTeam = {};
  Object.values(POOL).forEach(p => { if (!p.proTeamId) return; const a = mpg(p, '002027'), b = mpg(p, '002026');
    (byTeam[p.proTeamId] = byTeam[p.proTeamId] || []).push({ p, g: played(p), m: a.gp >= 3 ? a.m : b.m }); });
  const MATES = {}; let nPairs = 0;
  Object.keys(byTeam).forEach(tid => {
    const T = +tid, sps = Object.keys(games[T] || {}).map(Number).filter(sp => sp < today && (games[T][String(sp)] || []).length).sort((a, b) => a - b);
    const onTeam = x => { const other = Object.values(x.g).filter(s => s.proTeamId !== T).map(s => s.scoringPeriodId); const from = other.length ? Math.max(...other) + 1 : 0; return sps.filter(sp => sp >= from); };
    const key = byTeam[T].filter(x => x.m > 0).sort((a, b) => b.m - a.m).slice(0, 5);
    key.forEach(k => {
      const ksp = onTeam(k), out = ksp.filter(sp => !k.g[sp]);
      if (!out.length) return;
      let kind = null, when = '';
      if (k.p.injuryStatus === 'OUT') kind = 'out';
      else { const last = ksp[ksp.length - 1]; let i = ksp.length - 1; while (i >= 0 && k.g[ksp[i]]) i--;
        if (i >= 0 && i < ksp.length - 1 && ksp[i + 1] >= today - 7 && last != null) { kind = 'back'; when = dd(ksp[i + 1]); } }
      if (!kind) return;
      byTeam[T].forEach(s => {
        if (s.p.id === k.p.id || !A.logs[s.p.id]) return;
        const mine = onTeam(s).filter(sp => s.g[sp] && ksp.includes(sp)); const w = [], wo = [];
        mine.forEach(sp => (k.g[sp] ? w : wo).push(s.g[sp].appliedTotal || 0));
        if (w.length < 3 || wo.length < 3) return;
        const av = a => r1(a.reduce((x, y) => x + y, 0) / a.length), aWo = av(wo), aW = av(w);
        if (Math.abs(aWo - aW) < 3) return;
        (MATES[s.p.id] = MATES[s.p.id] || []).push([k.p.fullName, kind, when, aWo, wo.length, aW, w.length, k.p.injuryStatus || '', [k.p.id]]); nPairs++;
      });
    });
  });
  Object.keys(MATES).forEach(id => { const g = {}; // teammates who sat the exact same games give identical splits: merge into one line
    MATES[id].forEach(m => { const k = [m[1], m[2], m[3], m[4], m[5], m[6]].join('|'); if (g[k]) { g[k][0] += '、' + m[0]; g[k][8] = g[k][8].concat(m[8]); } else g[k] = m.slice(); });
    MATES[id] = Object.values(g); });
  Object.values(MATES).forEach(a => a.sort((x, y) => Math.abs(y[3] - y[5]) - Math.abs(x[3] - x[5])));
  // ---- prediction tracking + calibration ----
  // Each new line is snapshotted once: pred = the shown "other state" gap (back: avg with the mate
  // minus avg without; out: avg without minus avg with), base = the avg it is measured from. Then
  // the subject's next games in the predicted state (mate playing for 'back', still sitting for
  // 'out') are averaged: settled at 5 games, or at >= 2 if the mate's status flips / 30 days pass.
  // k = least-squares slope of actual vs predicted gap (through 0), applied on the site once a kind
  // has >= 15 settled predictions. Rules themselves (top 5, thresholds) are never changed here.
  const TR = A.matesTrack && A.matesTrack.open ? A.matesTrack : { open: {}, done: [] };
  Object.keys(MATES).forEach(sid => MATES[sid].forEach(m => { const key = sid + '|' + m[8].join(',') + '|' + m[1] + '|' + m[2];
    if (!TR.open[key] && !TR.done.some(d => d[6] === key)) TR.open[key] = { sid: +sid, mids: m[8], sn: A.logs[sid][0], mate: m[0], kind: m[1], sp0: today,
      base: m[1] === 'back' ? m[3] : m[5], pred: m[1] === 'back' ? r1(m[5] - m[3]) : r1(m[3] - m[5]) }; }));
  Object.keys(TR.open).forEach(key => { const t = TR.open[key], sp = POOL[t.sid]; if (!sp) return;
    const sg = played(sp), mg = t.mids.map(id => POOL[id] ? played(POOL[id]) : null); if (mg.some(x => !x)) return;
    const after = Object.keys(sg).map(Number).filter(x => x >= t.sp0).sort((a, b) => a - b), got = []; let flip = false;
    for (const x of after) { const ok = mg.every(g => t.kind === 'out' ? !g[x] : !!g[x]); if (!ok) { flip = true; break; } got.push(sg[x].appliedTotal || 0); if (got.length >= 5) break; }
    const old = today - t.sp0 > 30;
    if (got.length >= 5 || ((flip || old) && got.length >= 2)) { const act = r1(got.reduce((a, b) => a + b, 0) / got.length - t.base);
      TR.done.push([t.kind, t.pred, act, t.sn, t.mate, dd(t.sp0), key, got.length]); delete TR.open[key]; }
    else if (flip || old) delete TR.open[key]; });
  TR.done = TR.done.slice(-300);
  const calOf = list => { if (!list.length) return { n: 0 }; const sp2 = list.reduce((a, d) => a + d[1] * d[1], 0), sap = list.reduce((a, d) => a + d[1] * d[2], 0);
    const k = sp2 > 0 ? Math.max(0, Math.min(1.5, sap / sp2)) : 1;
    return { n: list.length, k: Math.round(k * 100) / 100, hit: Math.round(100 * list.filter(d => Math.sign(d[1]) === Math.sign(d[2])).length / list.length),
      mae: r1(list.reduce((a, d) => a + Math.abs(d[2] - d[1]), 0) / list.length), maeK: r1(list.reduce((a, d) => a + Math.abs(d[2] - k * d[1]), 0) / list.length) }; };
  A.matesTrack = TR;
  A.matesCal = { back: calOf(TR.done.filter(d => d[0] === 'back')), out: calOf(TR.done.filter(d => d[0] === 'out')), all: calOf(TR.done), open: Object.keys(TR.open).length, min: 15 };
  log.push('matesTrack open ' + A.matesCal.open + ' done ' + TR.done.length + ' cal ' + JSON.stringify(A.matesCal.all));
  // ---- feed the teammate splits into 增補建議 (picks) and 潛力發掘 (sleepers) ----
  // Only 'out' lines where the free agent scores more while the teammate sits, and only the
  // biggest one per player. Sleepers also get up to 3 extra free agents found only this way.
  try {
    const kOf = kind => { const c = A.matesCal[kind]; return c && c.n >= A.matesCal.min ? c.k : 1; };
    const boost = id => { const b = (MATES[id] || []).filter(m => m[1] === 'out' && m[3] - m[5] >= 3)[0]; return b ? { b, d: r1((b[3] - b[5]) * kOf('out')) } : null; };
    const sent = x => x.b[0] + ' 缺陣的 ' + x.b[4] + ' 場他平均 ' + x.b[3] + ' 分(有上場時 ' + x.b[5] + '),缺陣期間可能多 ' + x.d + ' 分左右。';
    const idOf = {}; Object.keys(A.logs).forEach(id => { idOf[A.logs[id][0]] = id; });
    let nP = 0, nS = 0;
    (A.picks || []).forEach(p => { const x = idOf[p.name] && boost(idOf[p.name]); if (x && p.why) { p.why += '隊友影響:' + sent(x); nP++; } });
    const S = A.sleepers && A.sleepers.rows;
    if (S) {
      S.forEach(r => { const x = idOf[r[0]] && boost(idOf[r[0]]); if (x) { r[9] += '隊友影響:' + sent(x); nS++; } });
      const have = new Set(S.map(r => r[0]));
      CTX.FAL.filter(p => !have.has(p.fullName) && p.injuryStatus !== 'OUT' && boost(p.id)).map(p => ({ p, x: boost(p.id) }))
        .sort((a, b) => b.x.d - a.x.d).slice(0, 3).forEach(({ p, x }) => { const q = POOL[p.id] || p;
          S.push([p.fullName, abbr[p.proTeamId], r1(p.ownership && p.ownership.percentOwned), CTX.mins(q, '012027'), CTX.mins(q, '002027'), CTX.avgPts(q, '012027'), CTX.avgPts(q, '002027'), CTX.avgPts(q, '002026'), x.b[0] + ' OUT', '隊友影響:' + sent(x)]); nS++; });
      A.sleepers.note = A.sleepers.note.replace(/(的人。)/, '$1另外也列出「隊友缺陣時明顯多拿分」的自由球員(看球員頁的隊友影響)。');
    }
    log.push('mates→picks ' + nP + ' sleepers ' + nS);
  } catch (e) { log.push('mates→picks FAIL ' + e.message); }
  if (Object.keys(POOL).length > 300) { A.mates = MATES; log.push('mates pool ' + Object.keys(POOL).length + ' players ' + Object.keys(MATES).length + ' pairs ' + nPairs); }
  else log.push('mates pool too small ' + Object.keys(POOL).length);
} catch (e) { log.push('mates FAIL ' + e.message); }

A.builtAt = new Date().toISOString();
const json = JSON.stringify(A).replace(/</g, '\\u003c');
html = html.replace(RE, (m, a, b, c) => a + json + c);
fs.writeFileSync('v2/index.html', html);
console.log(log.join('\n'));
