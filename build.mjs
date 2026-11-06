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
  const out = []; const mine = {};
  for (const t of meta.teams) {
    const j = await get(L + '?view=mRoster&scoringPeriodId=' + today + '&forTeamId=' + t.id);
    const tt = j.teams.find(x => x.id === t.id);
    tt.roster.entries.forEach(e => { const p = e.playerPoolEntry.player; p.eligibleSlots = e.playerPoolEntry.player.eligibleSlots || e.eligibleSlots; out.push(line(p, nm(t), p.eligibleSlots));
      if (nm(t) === 'aespa') mine[p.fullName] = { m7: mins(p, '012027'), m27: mins(p, '002027') }; });
  }
  const filt = { players: { filterStatus: { value: ['FREEAGENT', 'WAIVERS'] }, limit: 200, sortPercOwned: { sortPriority: 1, sortAsc: false }, filterStatsForTopScoringPeriodIds: { value: 5, additionalValue: ['002027', '012027', '022027', '002026'] } } };
  const fa = await get(L + '?view=kona_player_info', { 'x-fantasy-filter': JSON.stringify(filt) });
  (fa.players || []).forEach(x => { const p = x.player || x.playerPoolEntry.player; if (x.onTeamId === 0 || x.status === 'FREEAGENT' || x.status === 'WAIVERS' || x.onTeamId == null) out.push(line(p, x.status === 'WAIVERS' ? 'Waiver' : 'FA', p.eligibleSlots)); });
  if (out.length > 150) {
    A.cmp = out; log.push('cmp ' + out.length);
    A.rosterExtra = Object.fromEntries(Object.entries(A.rosterExtra || {}).map(([k, v]) => [k, Object.assign({}, v, mine[k] ? { m7: mine[k].m7, m27: mine[k].m27 } : {})]));
  } else log.push('cmp too few');
} catch (e) { log.push('cmp FAIL ' + e.message); }

A.builtAt = new Date().toISOString();
const json = JSON.stringify(A).replace(/</g, '\\u003c');
html = html.replace(RE, (m, a, b, c) => a + json + c);
fs.writeFileSync('index.html', html);
console.log(log.join('\n'));
