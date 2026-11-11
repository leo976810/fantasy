// Writes brief.json: a few-KB summary for Claude to read instead of data.json (~85 KB) or
// v2/index.html (~350 KB). It is cut from the exact data blob the site renders, after build.mjs,
// so the brief and the site can never disagree. No network calls.
import fs from 'node:fs';

const html = fs.readFileSync('v2/index.html', 'utf8');
const m = html.match(/<script id="data" type="application\/json">([\s\S]*?)<\/script>/);
if (!m) throw new Error('data blob not found in v2/index.html');
const D = JSON.parse(m[1]);

const tpeToday = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });
const hand = D.handAsof || {};
const sum = a => Math.round((a || []).reduce((x, y) => x + (y == null ? 0 : (Array.isArray(y) ? y[1] : y)), 0));
const MD = D.matchupDays || {}, P = MD.proj || {}, act = MD.actual || {};

const brief = {
  generated: new Date().toISOString(),
  numbersAsof: D.autoAsof,
  version: D.version,
  // hand-written sections whose advice predates today: re-check before acting on them
  staleSections: Object.keys(hand).filter(k => hand[k] < tpeToday).map(k => k + '@' + hand[k]),
  record: D.record,
  matchup: {
    opp: D.matchup && D.matchup.opp,
    me: D.matchup && D.matchup.meScore,
    them: D.matchup && D.matchup.oppScore,
    daysLeft: D.matchup && D.matchup.daysLeft,
    projRemaining: { me: sum(P.me), them: sum(P.op) },
    actualByDay: { me: act.me, them: act.op },
    lastWeek: D.weekReport || null,
  },
  // [slot, name, team, thisSeason, last7, lastSeason, own%, tierLabel]
  roster: (D.roster || []).map(r => [r[0], r[1], r[2], r[3], r[4], r[5], r[6], String(r[10] || '').split('。')[0]]),
  injuries: (D.injuries || []).map(i => [i[0], i[1], i[3], i[2]]),
  // best free-agent swaps per window: [add, team, estPerGame, games, dropFor, gain]
  stream: ((D.streamPlan || {}).windows || []).map(w => ({ window: w.label, top: w.rows.slice(0, 5).map(r => [r[0], r[1], r[4], r[5], r[6], r[9]]) })),
  leagueMoves: ((D.activity || {}).rows || []).slice(0, 12),
  todo: (D.todo || []).map(t => [t.lv, t.t]),
};

const out = JSON.stringify(brief);
fs.writeFileSync('brief.json', out);
console.log('brief.json', out.length, 'bytes; stale:', brief.staleSections.join(' ') || 'none');
