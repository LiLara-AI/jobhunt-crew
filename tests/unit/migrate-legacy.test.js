'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const MIGRATOR_PATH = path.join(__dirname, '..', '..', 'lib', 'operational', 'migrate-legacy.js');
const CREW_BIN = path.join(__dirname, '..', '..', 'bin', 'crew.js');
const migratorPresent = fs.existsSync(MIGRATOR_PATH);

// lib/operational/migrate-legacy is owned by Workstream D. These tests pin
// the CLI wiring contract (lib/cli/commands/migrate) and, once D lands the
// engine, its callable export — without guessing D's option schema.
describe('operational/migrate-legacy CLI wiring', () => {
  test('CLI migrate legacy fails gracefully when the engine is absent', (t) => {
    if (migratorPresent) {
      t.skip('migration engine present; absence path not applicable');
      return;
    }
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-migrate-unit-'));
    try {
      let output = '';
      let code = 0;
      try {
        output = execFileSync(process.execPath, [CREW_BIN, 'migrate', 'legacy', '--from', tmpDir, '--workspace', tmpDir], { encoding: 'utf8' });
      } catch (err) {
        code = err.status;
        output = `${err.stdout || ''}\n${err.stderr || ''}`;
      }
      assert.strictEqual(code, 1);
      assert.match(output, /migration engine not available/i);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('migration module exports a callable when present', (t) => {
    if (!migratorPresent) {
      t.skip('lib/operational/migrate-legacy not yet delivered (Workstream D)');
      return;
    }
    const mod = require(MIGRATOR_PATH);
    const fn = mod.migrateLegacy || mod.migrate || mod.runMigration || (typeof mod === 'function' ? mod : null);
    assert.strictEqual(typeof fn, 'function', 'migrate-legacy must export a callable migration function');
  });

  test('unknown migrate subcommands exit non-zero', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-migrate-unit-'));
    try {
      let code = 0;
      try {
        execFileSync(process.execPath, [CREW_BIN, 'migrate', 'bogus', '--workspace', tmpDir], { encoding: 'utf8', stdio: 'pipe' });
      } catch (err) {
        code = err.status;
      }
      assert.strictEqual(code, 1);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
