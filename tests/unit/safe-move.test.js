'use strict';

// Single-process checks for the move marker in lib/companion/bridge.js.
// The multi-process race itself is tests/tier2-boundary-corners/run-branch-race.js.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { safeMoveFile } = require('../../lib/companion/bridge');

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'safe-move-'));
  const src = path.join(dir, 'p.json');
  fs.writeFileSync(src, 'payload');
  return { dir, src, dest: path.join(dir, 'claimed.json'), marker: `${src}.moving` };
}

test('moves the file and leaves no marker behind', () => {
  const { dir, src, dest, marker } = setup();
  try {
    assert.equal(safeMoveFile(src, dest), true);
    assert.equal(fs.readFileSync(dest, 'utf8'), 'payload');
    assert.ok(!fs.existsSync(src) && !fs.existsSync(marker));
    assert.equal(safeMoveFile(src, dest), false, 'second move of a gone file loses');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a live marker from another mover blocks the move', () => {
  const { dir, src, dest, marker } = setup();
  try {
    fs.writeFileSync(marker, '');
    assert.equal(safeMoveFile(src, dest), false);
    assert.ok(fs.existsSync(src) && !fs.existsSync(dest), 'file untouched while another mover holds it');
    assert.ok(fs.existsSync(marker), 'someone else\'s marker is not removed');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a stale marker from a crashed mover is reclaimed', () => {
  const { dir, src, dest, marker } = setup();
  try {
    fs.writeFileSync(marker, '');
    const old = (Date.now() - 60000) / 1000;
    fs.utimesSync(marker, old, old);
    assert.equal(safeMoveFile(src, dest), true);
    assert.equal(fs.readFileSync(dest, 'utf8'), 'payload');
    assert.ok(!fs.existsSync(marker));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
