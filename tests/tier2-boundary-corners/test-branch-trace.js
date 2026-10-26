'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { fork } = require('child_process');

// Instrumented safeMoveFile that logs the exact branch taken
function instrumentedSafeMoveFile(src, dest, workerId, logFile, retries = 3) {
  function log(msg) {
    fs.appendFileSync(logFile, `[${new Date().toISOString()}] [${workerId}-${process.pid}] ${msg}\n`);
  }

  log(`safeMoveFile START: ${path.basename(src)} -> ${path.basename(dest)}`);
  if (!fs.existsSync(src)) {
    log(`safeMoveFile: src does not exist -> return false`);
    return false;
  }
  try {
    fs.renameSync(src, dest);
    if (!fs.existsSync(dest)) {
      log(`safeMoveFile: dest does not exist after renameSync -> return false`);
      return false;
    }
    log(`safeMoveFile: renameSync SUCCESS -> return true`);
    return true;
  } catch (err) {
    log(`safeMoveFile: renameSync FAILED with ${err.code}`);
    if (err.code === 'ENOENT') {
      log(`safeMoveFile: ENOENT -> return false`);
      return false;
    }
    if (
      process.platform === 'win32' &&
      (err.code === 'EPERM' || err.code === 'EBUSY' || err.code === 'EXDEV' || err.code === 'EACCES')
    ) {
      log(`safeMoveFile: entering win32 copy fallback`);
      try {
        fs.copyFileSync(src, dest);
        log(`safeMoveFile: copyFileSync SUCCESS`);
      } catch (copyErr) {
        log(`safeMoveFile: copyFileSync FAILED with ${copyErr.code}`);
        if (copyErr.code === 'ENOENT') {
          return false;
        }
        throw copyErr;
      }
      try {
        fs.unlinkSync(src);
        log(`safeMoveFile: unlinkSync SUCCESS -> return true`);
        return true;
      } catch (unlinkErr) {
        log(`safeMoveFile: unlinkSync FAILED with ${unlinkErr.code}`);
        if (unlinkErr.code === 'ENOENT') {
          try { fs.unlinkSync(dest); } catch (_) {}
          log(`safeMoveFile: cleaned up dest after ENOENT -> return false`);
          return false;
        }
        if (retries > 0) {
          log(`safeMoveFile: waiting 50ms to retry (${retries} retries left)`);
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
          const res = instrumentedSafeMoveFile(src, dest, workerId, logFile, retries - 1);
          log(`safeMoveFile: retry returned ${res}`);
          return res;
        }
        log(`safeMoveFile: retries exhausted -> return false`);
        return false;
      }
    } else {
      throw err;
    }
  }
}

module.exports = { instrumentedSafeMoveFile };
