'use strict';

/**
 * Concurrency probe for the REAL safeMoveFile in lib/companion/bridge.js:
 * 4 processes wait for the same file, then all try to move it at once.
 * Invariant: exactly one mover wins, and exactly one intact copy survives.
 * (On Windows a rename acts on an open handle, so two renames of one file
 * can both "succeed"; safeMoveFile must still pick a single winner.)
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { fork } = require('child_process');

const ITERATIONS = 100; // the unguarded rename broke within ~20 iterations on Windows
// RACE_MODULE lets you point the probe at another implementation (e.g. to prove it fails on the old one).
const BRIDGE = process.env.RACE_MODULE || path.resolve(__dirname, '../../lib/companion/bridge.js');

async function testOnce(iter) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `branch-race-${iter}-`));
  const target = path.join(tmp, 'target.json');

  // Workers spin on a "go" flag written right after the target, so the ones
  // already running contend at once and late starters lose without waiting.
  const go = path.join(tmp, 'go');
  const workerCode = `
    const fs = require('fs');
    const { safeMoveFile } = require(${JSON.stringify(BRIDGE)});
    const [,, target, claim, workerId, go] = process.argv;
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(go) && Date.now() < deadline) {}
    let win = false, error = null;
    try { win = safeMoveFile(target, claim); } catch (e) { error = e.code || e.message; }
    process.send({ win, workerId, error });
    process.exit(0);
  `;
  const wp = path.join(tmp, 'w.js');
  fs.writeFileSync(wp, workerCode, 'utf8');

  const promises = [];
  for (let c = 1; c <= 4; c++) {
    const child = fork(wp, [target, path.join(tmp, `claim_${c}.json`), `c${c}`, go]);
    promises.push(new Promise(r => child.on('message', r)));
  }

  const tmpProd = path.join(tmp, '.tmp_prod.json');
  fs.writeFileSync(tmpProd, 'hello', 'utf8');
  fs.renameSync(tmpProd, target);
  // Let the forked workers boot and reach their spin loop before releasing them.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
  fs.writeFileSync(go, '');

  const results = await Promise.all(promises);
  const winners = results.filter(r => r.win).map(r => r.workerId);
  const errors = results.filter(r => r.error).map(r => `${r.workerId}:${r.error}`);
  const survivors = fs.readdirSync(tmp).filter(f => /^claim_\d\.json$/.test(f));
  const intact = survivors.length === 1 && fs.readFileSync(path.join(tmp, survivors[0]), 'utf8') === 'hello';
  const leftovers = fs.readdirSync(tmp).filter(f => f.endsWith('.moving'));

  const ok = winners.length === 1 && intact && errors.length === 0 && leftovers.length === 0 &&
    survivors[0] === `claim_${winners[0].slice(1)}.json`;
  if (!ok) {
    console.log(`\nRACE INVARIANT BROKEN on iteration ${iter}: winners=[${winners}] survivors=[${survivors}] ` +
      `intact=${intact} errors=[${errors}] leftovers=[${leftovers}]`);
    return false;
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  return true;
}

(async () => {
  for (let i = 1; i <= ITERATIONS; i++) {
    if (!(await testOnce(i))) process.exit(1);
    process.stdout.write('.');
  }
  console.log(`\nAll ${ITERATIONS} iterations: exactly one winner, one intact copy.`);
})();
