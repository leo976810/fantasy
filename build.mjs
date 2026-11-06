// Builds index.html: keeps the page template + bulky snapshot data that is already embedded in index.html,
// overlays the fields maintained in data.json (hand-written text + numbers from update.mjs),
// and refreshes the ESPN-derived blocks (injDates, sch/paAvg, cmp, rosterExtra). Each block is try/catch: on failure the old value stays.
import fs from 'node:fs';
const BASE = 'https://lm-api-reads.fantasy.espn.com/apis/v3/games/fba/seasons/2027';
const L = BASE + '/segments/0/leagues/406470928';
const SITE = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba';
const get = async (u, h) => { const r = await fetch(u, { headers: h || {} }); if (!r.ok) throw new Error(u + ' -> HTTP ' + r.status); return r.json(); };
const r1 = v => v == null || isNaN(v) ? null : Math.round(v * 10) / 10;
const RE = /(<script id="data" type="application\/json">)([\s\S]*?)(<\/script>)/;
let html = fs.readFileSync('index.html', 'utf8');
const A = JSON.parse(html.match(RE)[2]);
const B = JSON.parse(fs.readFileSync('data.json', 'utf8'));
const log = [];
// 1) overlay data.json
const OVER = ['asof', 'league', 'record', 'matchup', 'recap', 'injuries', 'threads', 'roster', 'picks', 'pickNote', 'acqNote', 'sched', 'foot', 'stream', 'todo', 'sleepers', 'autoAsof', 'version', 'changelog'];
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

let CTX = null;
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
      if (nm(t) === 'aespa') mine[p.fullName] = { m7: mins(p, '012027'), m27: mins(p, '002027') }; });
  }
  const filt = { players: { filterStatus: { value: ['FREEAGENT', 'WAIVERS'] }, limit: 200, sortPercOwned: { sortPriority: 1, sortAsc: false }, filterStatsForTopScoringPeriodIds: { value: 5, additionalValue: ['002027', '012027', '022027', '002026'] } } };
  const fa = await get(L + '?view=kona_player_info', { 'x-fantasy-filter': JSON.stringify(filt) });
  (fa.players || []).forEach(x => { const p = x.player || x.playerPoolEntry.player; if (x.onTeamId === 0 || x.status === 'FREEAGENT' || x.status === 'WAIVERS' || x.onTeamId == null) { out.push(line(p, x.status === 'WAIVERS' ? 'Waiver' : 'FA', p.eligibleSlots)); FAL.push(Object.assign({}, p, { own: x.status === 'WAIVERS' ? 'Waiver' : 'FA' })); } });
  CTX = { abbr, games, today, base, has, rest, next, avgPts, RO, FAL, nm };
  if (out.length > 150) {
    A.cmp = out; log.push('cmp ' + out.length);
    A.rosterExtra = Object.fromEntries(Object.entries(A.rosterExtra || {}).map(([k, v]) => [k, Object.assign({}, v, mine[k] ? { m7: mine[k].m7, m27: mine[k].m27 } : {})]));
  } else log.push('cmp too few');
} catch (e) { log.push('cmp FAIL ' + e.message); }

try { // decision data: best lineup per day, injuries, free-agent hot list, per-day detail
  if (!CTX) throw new Error('no ctx');
  const { abbr, games, today, base, has, rest, next, avgPts, RO, FAL, nm } = CTX;
  const full = await get(L + '?view=mTeam&view=mMatchupScore&view=mSettings');
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
  const LU = []; let weak = null;
  for (let sp = today; sp < base + 7; sp++) {
    const i = sp - base; const jr = await get(L + '?view=mRoster&scoringPeriodId=' + sp + '&forTeamId=' + meId);
    const ents = jr.teams.find(x => x.id === meId).roster.entries.map(e => Object.assign({}, e.playerPoolEntry.player, { slot: e.lineupSlotId }));
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
  const INJ = RO[meId].filter(p => p.injuryStatus === 'OUT' || p.injuryStatus === 'DAY_TO_DAY').map(p => [p.fullName, inj(p), p.slot === 13 ? 'IR' : p.slot === 12 ? 'BN' : '先發', r1(blend(p)), rest(p.proTeamId), next(p.proTeamId),
    p.slot === 13 ? '在 IR,回歸前不佔名額' : inj(p) === 'OUT' ? '目前 OUT,先發要換人' : '上場前確認狀態']);
  // (c) free-agent hot list
  const hot = FAL.filter(p => p.injuryStatus !== 'OUT' && rest(p.proTeamId) >= 1).map(p => ({ p, e: blend(p), l7: avgPts(p, '012027'), s27: avgPts(p, '002027') }))
    .filter(x => x.e != null && weak != null && ((x.l7 != null && x.s27 != null && x.l7 - x.s27 >= 5) || x.e >= weak - 3) && x.e >= 17).sort((a, b) => b.e - a.e).slice(0, 12)
    .map(x => { const p = x.p, pos = A.cmp.map(l => l.split('|')).find(a => a[0] == p.id); return [p.fullName, abbr[p.proTeamId], p.own, r1(p.ownership && p.ownership.percentOwned), x.s27, x.l7, avgPts(p, '002026'), rest(p.proTeamId), next(p.proTeamId), pos ? pos[3] : '', r1(x.e - weak), inj(p)]; });
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
  A.insights = Object.assign({}, A.insights, { LU, INJ, hot, weak: r1(weak) });
  log.push('decision LU ' + LU.length + ' INJ ' + INJ.length + ' hot ' + hot.length + ' dayDetail ' + Object.keys(dd.me).length);
} catch (e) { log.push('decision FAIL ' + e.message); }

A.builtAt = new Date().toISOString();
const json = JSON.stringify(A).replace(/</g, '\\u003c');
html = html.replace(RE, (m, a, b, c) => a + json + c);
fs.writeFileSync('index.html', html);
console.log(log.join('\n'));
