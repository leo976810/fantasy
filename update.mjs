// Refreshes the numeric parts of data.json from ESPN's public league API.
// Hand-written judgment text (todo, threads, team judgments, picks reasons) is kept as is.
import fs from 'node:fs';
const BASE = 'https://lm-api-reads.fantasy.espn.com/apis/v3/games/fba/seasons/2027';
const L = BASE + '/segments/0/leagues/406470928';
const ME = 'aespa';
const get = async (u, h) => { const r = await fetch(u, { headers: h || {} }); if (!r.ok) throw new Error(u + ' -> HTTP ' + r.status); return r.json(); };
const D = JSON.parse(fs.readFileSync('data.json', 'utf8'));

const nm = t => t.name || ((t.location || '') + ' ' + (t.nickname || '')).trim();
const r1 = v => v == null ? null : Math.round(v * 10) / 10;
const sumTop = a => a.sort((x, y) => y - x).slice(0, 10).reduce((x, y) => x + y, 0);

const meta = await get(L + '?view=mTeam&view=mMatchupScore&view=mSettings');
const cal = await get(BASE + '?view=proTeamSchedules_wl');
const teams = meta.teams, byId = {};
teams.forEach(t => byId[t.id] = t);
const abbr = {}, games = {};
cal.settings.proTeams.forEach(p => { abbr[p.id] = p.abbrev; games[p.id] = p.proGamesByScoringPeriod || {}; });
const cur = meta.status.currentMatchupPeriod;
const today = meta.scoringPeriodId;
// Matchup period 3 started on scoring period 14 (Mon 11/2); each matchup period is 7 scoring periods.
let base = 14 + 7 * (cur - 3);
try {
  const g0 = meta.schedule.find(g => g.matchupPeriodId === cur && g.home && g.home.pointsByScoringPeriod);
  const ks = Object.keys(g0.home.pointsByScoringPeriod).map(Number).filter(n => n >= base - 1);
  if (ks.length) base = Math.min(...ks);
} catch (e) {}
// a scoring day counts as finished when its scoring period has passed, or all of today's NBA games started 3.5+ hours ago
const dayDone = sp => { if (sp < today) return true; if (sp > today) return false; const ds = []; Object.keys(games).forEach(t => (games[t][String(sp)] || []).forEach(g => ds.push(g.date))); return ds.length > 0 && Math.max(...ds) + 3.5 * 3600000 < Date.now(); };
const hasGame = (tid, sp) => (games[tid] && (games[tid][String(sp)] || []).length > 0) ? 1 : 0;
const nextWeek = tid => { let n = 0; for (let i = 7; i < 14; i++) n += hasGame(tid, base + i); return n; };

function stat(p, id) { const s = (p.stats || []).find(x => x.id === id); return s && s.appliedAverage != null ? r1(s.appliedAverage) : null; }
const SLOT = { 0: 'PG', 1: 'SG', 2: 'SF', 3: 'PF', 4: 'C', 5: 'G', 6: 'F', 11: 'UTIL', 12: 'BN', 13: 'IR' };
function tier(slot, s27, s26, l7) {
  if (slot === 'IR') return ['ir', 'IR'];
  const v = [s27, s26].filter(x => x != null);
  const m = v.length ? v.reduce((a, b) => a + b, 0) / v.length : (l7 || 0);
  return m >= 40 ? ['core', '核心'] : m >= 32 ? ['ok', '主力'] : m >= 25 ? ['watch', '輪換'] : ['drop', '低產出'];
}
function verdict(slot, s27, l7, s26, inj) {
  const p = [];
  if (inj === 'OUT') p.push(slot === 'IR' ? '在 IR(OUT),回歸前不計分,回來後增加戰力' : '受傷缺陣(OUT)');
  else if (inj === 'DAY_TO_DAY') p.push(slot === 'IR' ? '在 IR,狀態為 DTD' : 'DTD,上場前要確認');
  if (s27 != null && s26 != null) { const d = s27 - s26; p.push(d >= 5 ? '今年高於去年(+' + Math.round(d) + ')' : d <= -5 ? '今年低於去年(' + Math.round(d) + ')' : '兩季穩定'); }
  else if (s27 != null) p.push('沒有去年樣本');
  else if (s26 != null) p.push('今年尚無出賽,去年 ' + Math.round(s26));
  if (l7 != null && s27 != null) { if (l7 - s27 >= 6) p.push('近 7 場升溫'); else if (l7 - s27 <= -6) p.push('近 7 場降溫'); }
  return p.join('。') + '。';
}
async function roster(id) {
  const j = await get(L + '?view=mRoster&scoringPeriodId=' + today + '&forTeamId=' + id);
  const t = j.teams.find(x => x.id === id);
  return t.roster.entries.map(e => {
    const p = e.playerPoolEntry.player;
    const slot = SLOT[e.lineupSlotId] || '?';
    const s27 = stat(p, '002027'), l7 = stat(p, '012027'), l15 = stat(p, '022027'), s26 = stat(p, '002026');
    return { name: p.fullName, tid: p.proTeamId, slot, s27, l7, l15, s26, own: r1(p.ownership && p.ownership.percentOwned), inj: p.injuryStatus,
      d: [4, 5, 6].map(i => hasGame(p.proTeamId, base + i)), nx: nextWeek(p.proTeamId) };
  });
}
const short = f => { const a = f.split(' '); return a.length > 1 ? a[0][0] + '.' + a.slice(1).join(' ') : f; };
const rows = (arr, full) => arr.map(x => { const [c, lbl] = tier(x.slot, x.s27, x.s26, x.l7);
  return [x.slot, full ? x.name : short(x.name), abbr[x.tid], x.s27, x.l7, x.s26, x.own, x.d, x.nx, c, lbl + '。' + verdict(x.slot, x.s27, x.l7, x.s26, x.inj)]; });

const R = {}; const ids = teams.map(t => t.id);
for (const id of ids) R[id] = await roster(id);
const idByName = {}; teams.forEach(t => idByName[nm(t)] = t.id);

// standings and rosters
const opp = {};
meta.schedule.filter(g => g.matchupPeriodId === cur && g.away).forEach(g => {
  opp[g.home.teamId] = { s: g.home.totalPointsLive, o: g.away.totalPointsLive, id: g.away.teamId, g, me: g.home, other: g.away };
  opp[g.away.teamId] = { s: g.away.totalPointsLive, o: g.home.totalPointsLive, id: g.home.teamId, g, me: g.away, other: g.home };
});
const lg = D.league; lg.rosters = lg.rosters || {};
[lg.you].concat(lg.teams).forEach(r => {
  const id = idByName[r[0]]; if (id == null) return;
  const o = byId[id].record.overall; r[1] = o.wins + '-' + o.losses; r[2] = Math.round(o.pointsFor); r[3] = Math.round(o.pointsAgainst);
  const m = opp[id];
  if (m) { const full = nm(byId[m.id]); const old = String(r[4]).match(/^[\d.]+–[\d.]+ (.*)$/); const s = old && full.indexOf(old[1]) === 0 ? old[1] : full.split(' ')[0]; r[4] = Math.round(m.s) + '–' + Math.round(m.o) + ' ' + s; }
  if (r[0] !== ME) lg.rosters[r[0]] = rows(R[id], false);
});

// my roster: refresh numbers, keep hand-written text for players already listed
const meId = idByName[ME];
const old = {}; (D.roster || []).forEach(r => old[r[1]] = r);
D.roster = R[meId].map(x => { const [c, lbl] = tier(x.slot, x.s27, x.s26, x.l7); const o = old[x.name];
  return [x.slot, x.name, abbr[x.tid], x.s27, x.l7, x.s26, x.own, x.d, x.nx, o ? o[9] : c, o ? o[10] : lbl + '。' + verdict(x.slot, x.s27, x.l7, x.s26, x.inj)]; });
D.record = byId[meId].record.overall.wins + '-' + byId[meId].record.overall.losses;

// matchup
const mm = opp[meId]; const oppId = mm.id; const oppName = nm(byId[oppId]);
const DAYS = D.matchupDays.days;
// today's scoring period is still in progress (or not started), so it counts as not finished
const pickPts = g => DAYS.map((_, i) => { const v = (g.pointsByScoringPeriod || {})[String(base + i)]; return v == null || !dayDone(base + i) ? null : r1(v); });
const act = { me: pickPts(mm.me), op: pickPts(mm.other) };
const counts = arr => DAYS.map((_, i) => arr.filter(x => x.slot !== 'IR' && hasGame(x.tid, base + i)).length);
const val = x => x.l7 != null ? x.l7 : x.l15 != null ? x.l15 : x.s27 != null ? x.s27 : x.s26 != null ? x.s26 : 0;
const dayPts = (arr, i) => { const p = arr.filter(x => x.slot !== 'IR' && x.inj !== 'OUT' && hasGame(x.tid, base + i)); return [Math.min(p.length, 10), r1(sumTop(p.map(val)))]; };
const nPast = act.me.filter(v => v != null).length;
const rem = DAYS.map((_, i) => i).filter(i => act.me[i] == null);
const mine = R[meId], theirs = R[oppId];
const weekChanged = D.matchupDays.opp !== oppName;
D.matchup = Object.assign({}, D.matchup, { me: ME, opp: oppName, meScore: Math.round(mm.s), oppScore: Math.round(mm.o), daysLeft: rem.map(i => DAYS[i].replace('週', '週')).join('、') });
if (weekChanged) D.matchup.oppNote = '新的一週,對手評語由每日分析更新。';
D.matchupDays = Object.assign({}, D.matchupDays, { opp: oppName, me: counts(mine), op: counts(theirs), actual: act,
  proj: Object.assign({}, D.matchupDays.proj, { days: rem.map(i => DAYS[i]), me: rem.map(i => dayPts(mine, i)), op: rem.map(i => dayPts(theirs, i)) }),
  estPast: { me: DAYS.map((_, i) => act.me[i] != null ? dayPts(mine, i)[1] : null), op: DAYS.map((_, i) => act.op[i] != null ? dayPts(theirs, i)[1] : null) } });

D.doneSp = dayDone(today) ? today : today - 1;
D.autoAsof = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false });
fs.writeFileSync('data.json', JSON.stringify(D, null, 1));
console.log('updated', D.autoAsof, 'period', cur, 'today', today, 'base', base, 'opp', oppName, 'past days', nPast);
