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
async function roster(id, sp) {
  const j = await get(L + '?view=mRoster&scoringPeriodId=' + (sp || today) + '&forTeamId=' + id);
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

// my roster: numbers AND the tier/verdict text are regenerated every run. The text used to be kept
// from the previous data.json, so it kept quoting old numbers (e.g. "今年 40.9" next to a live 39.7)
// and old injury status. Judgment about a player belongs in todo/picks, which carry handAsof dates.
const meId = idByName[ME];
D.roster = rows(R[meId], true);
D.record = byId[meId].record.overall.wins + '-' + byId[meId].record.overall.losses;

// matchup
const mm = opp[meId]; const oppId = mm.id; const oppName = nm(byId[oppId]);
const DAYS = D.matchupDays.days;
// today's scoring period is still in progress (or not started), so it counts as not finished
const pickPts = g => DAYS.map((_, i) => { const v = (g.pointsByScoringPeriod || {})[String(base + i)]; return v == null || !dayDone(base + i) ? null : r1(v); });
const act = { me: pickPts(mm.me), op: pickPts(mm.other) };
const val = x => x.l7 != null ? x.l7 : x.l15 != null ? x.l15 : x.s27 != null ? x.s27 : x.s26 != null ? x.s26 : 0;
const nPast = act.me.filter(v => v != null).length;
const rem = DAYS.map((_, i) => i).filter(i => act.me[i] == null);
const mine = R[meId], theirs = R[oppId];
// ESPN's roster membership is effective-dated: an add/drop made today can take effect starting
// tomorrow (e.g. a streaming swap), so a single "today" roster snapshot under- or over-counts a
// future day's games whenever either side's bench has already changed for that day. For each day
// still ahead (rem), fetch that day's own effective roster instead of reusing today's snapshot --
// this is what caught Leo's opponent picking up Hachimura/Dunn (effective tomorrow, not today).
const dayRoster = { me: {}, op: {} };
for (const i of rem) {
  const sp = base + i;
  dayRoster.me[i] = sp === today ? mine : await roster(meId, sp);
  dayRoster.op[i] = sp === today ? theirs : await roster(oppId, sp);
}
const arrFor = (side, i, fallback) => (dayRoster[side] && dayRoster[side][i]) || fallback;
const counts = (side, fallback) => DAYS.map((_, i) => arrFor(side, i, fallback).filter(x => x.slot !== 'IR' && hasGame(x.tid, base + i)).length);
const dayPts = (side, fallback, i) => { const p = arrFor(side, i, fallback).filter(x => x.slot !== 'IR' && x.inj !== 'OUT' && hasGame(x.tid, base + i)); return [Math.min(p.length, 10), r1(sumTop(p.map(val)))]; };
// Detect the matchup week turning over by the scoring-period anchor (base), not by opponent name --
// a name comparison misses the turnover whenever this week's opponent happens to be the same team
// as last week's (which is exactly what happened at the Matchup 3 -> 4 turnover), silently leaving
// 上週戰報 (weekReport) stuck empty forever for that week. base is unambiguous: it only matches when
// it's genuinely the same matchup period.
const weekChanged = D.matchupBase !== base;
// matchupDays.dates was a frozen MM/DD snapshot that nothing in the pipeline ever refreshed, so it
// silently went stale every single week turnover (stuck showing last week's calendar dates in the
// 戰況 tab). Recompute it fresh every run from base: scoring period 14 = Mon 11/2/2026 (see the
// `base` comment above), and every matchup period is a consecutive 7-day block from there.
const ANCHOR_SP = 14, ANCHOR_MS = Date.UTC(2026, 10, 2);
const spDate = sp => { const dt = new Date(ANCHOR_MS + (sp - ANCHOR_SP) * 86400000); return (dt.getUTCMonth() + 1) + '/' + dt.getUTCDate(); };
const DATES = DAYS.map((_, i) => spDate(base + i));
// Capture last week's final score before D.matchup gets overwritten below with this week's --
// build.mjs picks this up (alongside the burst/bust weekly tally it already keeps) to assemble
// a 週報 (weekly report) summarizing the week that just ended, for next week's strategy.
if (weekChanged && D.matchup.opp) D.lastWeekResult = { opp: D.matchup.opp, meScore: D.matchup.meScore, oppScore: D.matchup.oppScore };
D.matchup = Object.assign({}, D.matchup, { me: ME, opp: oppName, meScore: Math.round(mm.s), oppScore: Math.round(mm.o), daysLeft: rem.map(i => DAYS[i].replace('週', '週')).join('、') });
if (weekChanged) D.matchup.oppNote = '新的一週,對手評語由每日分析更新。';
D.matchupDays = Object.assign({}, D.matchupDays, { opp: oppName, dates: DATES, me: counts('me', mine), op: counts('op', theirs), actual: act,
  proj: Object.assign({}, D.matchupDays.proj, { days: rem.map(i => DAYS[i]), me: rem.map(i => dayPts('me', mine, i)), op: rem.map(i => dayPts('op', theirs, i)) }),
  estPast: { me: DAYS.map((_, i) => act.me[i] != null ? dayPts('me', mine, i)[1] : null), op: DAYS.map((_, i) => act.op[i] != null ? dayPts('op', theirs, i)[1] : null) } });
D.matchupBase = base;

// ---- schedule summary (賽程場次), fully derived from the NBA calendar every run ----
// Used to be hand-written, so its dates and team lists froze on the week it was last edited.
const WD = ['週一', '週二', '週三', '週四', '週五', '週六', '週日'];
const teamIds = Object.keys(games).map(Number).filter(t => abbr[t]);
const nGames = (tid, from, to) => { let n = 0; for (let sp = from; sp <= to; sp++) n += hasGame(tid, sp); return n; };
const dayGames = sp => teamIds.filter(t => hasGame(t, sp)).length / 2;
const byCount = (from, to) => { const m = {}; teamIds.forEach(t => { const n = nGames(t, from, to); (m[n] = m[n] || []).push(abbr[t]); }); Object.values(m).forEach(a => a.sort()); return m; };
const wk = byCount(base, base + 6), nwk = byCount(base + 7, base + 13);
const maxN = Math.max(...Object.keys(wk).map(Number));
const fromIdx = Math.max(0, Math.min(6, today - base + (dayDone(today) ? 1 : 0)));
const restDays = []; for (let i = fromIdx; i < 7; i++) restDays.push([WD[i] + ' ' + DATES[i], dayGames(base + i) + ' 場']);
// weekend streaming window: teams with exactly 2 games across Fri-Sun, grouped by which days
const wkend = {}; teamIds.forEach(t => { const ds = [4, 5, 6].filter(i => hasGame(t, base + i)); if (ds.length === 2) { const k = ds.map(i => WD[i]).join('、'); (wkend[k] = wkend[k] || []).push(abbr[t]); } });
D.sched = {
  rest: restDays,
  full: wk[maxN] || [],
  fullN: maxN,
  done: restDays.length === 7 ? '新的一週(' + DATES[0] + '–' + DATES[6] + ')剛開始,以下是整週的場次。' : '本週 ' + DATES[0] + '–' + DATES[6] + ',上面只列還沒打完的比賽日。',
  rest2: Object.entries(wkend).map(([k, v]) => [k, v.sort()]),
  three: (wk[3] || []).join('、'),
  four: (nwk[4] || []).join('、') || '無',
  two_next: (nwk[2] || []).join('、') || '無',
  nextLabel: '下週(' + spDate(base + 7) + '–' + spDate(base + 13) + ')',
};

// ---- injury report (傷兵快報), derived every run from ESPN injury status + return dates ----
// Covers my roster and this week's opponent. Used to be hand-written and kept saying a player
// "returns today" days after the fact.
try {
  const ij = await get('https://site.api.espn.com/apis/site/v2/sports/basketball/nba/injuries');
  const md = iso => { const d = new Date(iso); return isNaN(d) ? '' : (d.getUTCMonth() + 1) + '/' + d.getUTCDate(); };
  // ESPN gives side/location/detail in English; translate the common words, keep unknown ones as is
  const ZH = { Left: '左', Right: '右', Leg: '腿', Knee: '膝', Ankle: '腳踝', Foot: '腳', Hamstring: '大腿後肌', Thigh: '大腿', Calf: '小腿', Achilles: '阿基里斯腱',
    Hip: '髖部', Groin: '鼠蹊', Back: '背部', Shoulder: '肩膀', Elbow: '手肘', Wrist: '手腕', Hand: '手', Finger: '手指', Toe: '腳趾', Head: '頭部', Neck: '頸部', Abdomen: '腹部', Chest: '胸部',
    Sprain: '扭傷', Strain: '拉傷', Soreness: '痠痛', Surgery: '手術', Inflammation: '發炎', Contusion: '挫傷', Bruise: '挫傷', Fracture: '骨折', Tear: '撕裂', Tendinitis: '肌腱炎',
    Illness: '生病', Rest: '休息', Concussion: '腦震盪', Personal: '個人因素', Suspension: '禁賽', Injury: '傷勢' };
  const zh = s => String(s).split(' ').map(w => ZH[w] || w).join('');
  const info = {};
  (ij.injuries || []).forEach(t => (t.injuries || []).forEach(i => { const n = i.athlete && i.athlete.displayName; if (!n) return; const d = i.details || {};
    info[n] = { ret: md(d.returnDate), what: [d.side, d.location || d.type, d.detail].filter(x => x && x !== 'Not Specified').map(zh).join('') }; }));
  const list = [];
  const add = (x, who) => { if (!x.inj || x.inj === 'ACTIVE') return; const out = x.inj === 'OUT' || x.slot === 'IR' && x.inj !== 'DAY_TO_DAY';
    const k = info[x.name] || {}; const tm = abbr[x.tid];
    const playsToday = hasGame(x.tid, today) && !dayDone(today);
    const txt = who + (k.what ? k.what + ',' : '') + 'ESPN 標 ' + (out ? 'OUT' : 'DTD') + (k.ret ? ',預計 ' + k.ret + ' 回歸' : ',回歸日未定') +
      (who.indexOf('你的') === 0 && !out ? (playsToday ? ';' + tm + ' 今天有比賽,上場前要確認。' : ';' + tm + ' 今天沒有比賽。') : '。');
    list.push([out ? 'out' : 'dtd', x.name, txt, k.ret || '未定']); };
  R[meId].forEach(x => add(x, '你的 ' + x.slot + '。'));
  R[oppId].forEach(x => add(x, '對手 ' + oppName + '。'));
  const mdv = s => { const m = /^(\d+)\/(\d+)$/.exec(s); return m ? (+m[1] < 7 ? 12 + +m[1] : +m[1]) * 100 + +m[2] : 9999; };
  D.injuries = list.sort((a, b) => (a[0] === b[0] ? 0 : a[0] === 'dtd' ? -1 : 1) || mdv(a[3]) - mdv(b[3]));
} catch (e) { console.log('injuries FAIL', e.message); }

// hand-written judgment sections each carry the date they were last written (handAsof). The site shows
// a "written on X" notice on any section older than today, so fresh numbers never sit next to old advice
// without saying so. Whoever edits todo/picks/threads/recap/sleepers/fridayLineup must update its date.
if (!D.handAsof) { const d0 = String(D.asof || '').slice(0, 10); D.handAsof = { todo: d0, picks: d0, threads: d0, recap: d0, sleepers: d0, fridayLineup: d0 }; }

D.doneSp = dayDone(today) ? today : today - 1;
D.autoAsof = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false });
// Records the latest executed-transaction timestamp this run has accounted for, so gate.mjs
// can tell a fresh add/drop/trade from one it already picked up and force an out-of-slot run
// when something new has landed (instead of waiting up to ~4h for the next regular slot).
try {
  const txj = await get(L + '?view=mTransactions2&scoringPeriodId=' + today);
  const times = (txj.transactions || []).filter(t => t.status === 'EXECUTED').map(t => t.processDate || t.proposedDate || 0);
  if (times.length) D.lastTxSeen = Math.max(D.lastTxSeen || 0, ...times);
} catch (e) { /* non-fatal: gate just keeps using whatever D.lastTxSeen already had */ }
fs.writeFileSync('data.json', JSON.stringify(D, null, 1));
console.log('updated', D.autoAsof, 'period', cur, 'today', today, 'base', base, 'opp', oppName, 'past days', nPast);
