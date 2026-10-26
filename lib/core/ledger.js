'use strict';

/**
 * JobHunt Crew — Core Ledger Re-export Facade
 * Location: lib/core/ledger.js
 */

const ledger = require('../ledger/ledger');
const reducer = require('../ledger/reducer');
const lock = require('../ledger/lock');

module.exports = {
  EventLedger: ledger.EventLedger,
  canonicalJsonString: ledger.canonicalJsonString,
  sha256: ledger.sha256,
  reduceEvents: reducer.reduceEvents,
  replayLedger: reducer.replayLedger,
  writeSnapshotAtomically: reducer.writeSnapshotAtomically,
  canonicalizeUrl: reducer.canonicalizeUrl,
  FileLock: lock.FileLock,
  withLock: lock.withLock,
  isPidAlive: lock.isPidAlive
};
