// Decides whether the scheduled run should do a full refresh: always on manual/push runs,
// on the regular 4-hour slot, when a new NBA day just finished (last tip-off + 3.5h), or
// when a league transaction (add/drop/trade) has landed since the last full run -- this is
// what catches an opponent streaming players mid-week instead of leaving the site stale for
// up to 4 hours until the next slot.
import fs from 'node:fs';
import { appendFileSync } from 'node:fs';
const BASE = 'https://lm-api-reads.fantasy.espn.com/apis/v3/games/fba/seasons/2027';
const out = v => { console.log('run=' + v); if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, 'run=' + v + '\n'); };
if (process.env.GITHUB_EVENT_NAME !== 'schedule') { out(true); process.exit(0); }
try {
  const D = JSON.parse(fs.readFileSync('data.json', 'utf8'));
  const j = await (await fetch(BASE + '/segments/0/leagues/406470928?view=mTeam')).json();
  const cal = await (await fetch(BASE + '?view=proTeamSchedules_wl')).json();
  const today = j.scoringPeriodId, games = {};
  cal.settings.proTeams.forEach(p => games[p.id] = p.proGamesByScoringPeriod || {});
  const ds = []; Object.keys(games).forEach(t => (games[t][String(today)] || []).forEach(g => ds.push(g.date)));
  const done = ds.length > 0 && Math.max(...ds) + 3.5 * 3600000 < Date.now();
  const doneSp = done ? today : today - 1;
  const now = new Date();
  const slot = now.getUTCHours() % 4 === 1 && now.getUTCMinutes() < 30;
  let newTx = false, latestTx = D.lastTxSeen || 0;
  try {
    const txj = await (await fetch(BASE + '/segments/0/leagues/406470928?view=mTransactions2&scoringPeriodId=' + today)).json();
    const times = (txj.transactions || []).filter(t => t.status === 'EXECUTED').map(t => t.processDate || t.proposedDate || 0);
    if (times.length) latestTx = Math.max(latestTx, ...times);
    newTx = latestTx > (D.lastTxSeen || 0);
  } catch (e) { console.log('tx check error', e.message); }
  console.log('doneSp', doneSp, 'stored', D.doneSp, 'slot', slot, 'newTx', newTx, 'latestTx', latestTx, 'storedTx', D.lastTxSeen || 0);
  out(doneSp !== D.doneSp || slot || newTx);
} catch (e) { console.log('gate error', e.message); out(true); }
