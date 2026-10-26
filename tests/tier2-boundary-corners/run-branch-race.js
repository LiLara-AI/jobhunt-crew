'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { fork } = require('child_process');

async function testOnce(iter) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `branch-race-${iter}-`));
  const logFile = path.join(tmp, 'branch.log');
  const target = path.join(tmp, 'target.json');

  const workerCode = `
    const { instrumentedSafeMoveFile } = require(${JSON.stringify(path.resolve(__dirname, './test-branch-trace'))});
    const [,, target, claim, workerId, logFile] = process.argv;
    const res = instrumentedSafeMoveFile(target, claim, workerId, logFile);
    process.send({ win: res, workerId });
    process.exit(0);
  `;
  const wp = path.join(tmp, 'w.js');
  fs.writeFileSync(wp, workerCode, 'utf8');

  // Spawn 4 consumers simultaneously
  const children = [];
  const promises = [];
  for (let c = 1; c <= 4; c++) {
    const claim = path.join(tmp, `claim_${c}.json`);
    const child = fork(wp, [target, claim, `c${c}`, logFile]);
    children.push(child);
    promises.push(new Promise(r => child.on('message', r)));
  }

  // Sleep 5ms
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);

  // Producer writes tmp and renames to target
  const tmpProd = path.join(tmp, '.tmp_prod.json');
  fs.writeFileSync(tmpProd, 'hello', 'utf8');
  try {
    fs.renameSync(tmpProd, target);
  } catch (_) {}

  const results = await Promise.all(promises);
  const winners = results.filter(r => r.win);

  if (winners.length > 1) {
    console.log(`\nDUPLICATE WINNERS CAUGHT on iteration ${iter}! Winners: ${winners.map(w => w.workerId).join(', ')}`);
    const logContent = fs.readFileSync(logFile, 'utf8');
    console.log('=== BRANCH LOG ===');
    console.log(logContent);
    return false;
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  return true;
}

(async () => {
  for (let i = 1; i <= 200; i++) {
    const ok = await testOnce(i);
    if (!ok) process.exit(1);
    process.stdout.write('.');
  }
  console.log('\nAll 200 iterations passed with <= 1 winner.');
})();
