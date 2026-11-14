// Refreshes the numeric parts of data.json from ESPN's public league API (GitHub Actions step).
// The logic lives in v2/live.mjs, which the website also runs in the browser for live numbers.
// Hand-written judgment text (todo, threads) is kept as is.
import fs from 'node:fs';
import { refresh } from './v2/live.mjs';
const D = JSON.parse(fs.readFileSync('data.json', 'utf8'));
console.log((await refresh(D)).log);
fs.writeFileSync('data.json', JSON.stringify(D, null, 1));
