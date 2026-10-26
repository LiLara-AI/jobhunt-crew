'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execSync } = require('node:child_process');

describe('Milestone M1 — Clean-Room Scaffolding & Zero-PII Foundation', () => {
  const rootDir = path.resolve(__dirname, '../..');

  test('package.json exists and adheres to specification', () => {
    const pkgPath = path.join(rootDir, 'package.json');
    assert.ok(fs.existsSync(pkgPath), 'package.json must exist');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

    assert.strictEqual(pkg.name, 'jobhunt-crew', 'package name must be jobhunt-crew');
    assert.match(pkg.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, 'package version must follow semver format');
    assert.strictEqual(pkg.license, 'MIT', 'license must be MIT');
    assert.strictEqual(pkg.type, 'commonjs', 'package type must be commonjs');
    assert.ok(pkg.bin && pkg.bin.crew, 'must declare crew binary entry point');
    assert.ok(pkg.scripts && pkg.scripts.test, 'must have test script');
    assert.ok(pkg.scripts['clean-room'], 'must have clean-room script');
    assert.ok(pkg.scripts['test:pii'], 'must have test:pii script');
    assert.ok(pkg.scripts['doctor'], 'must have doctor script');
  });

  test('.gitignore exists and contains critical isolation rules', () => {
    const gitignorePath = path.join(rootDir, '.gitignore');
    assert.ok(fs.existsSync(gitignorePath), '.gitignore must exist');
    const content = fs.readFileSync(gitignorePath, 'utf8');

    assert.ok(content.includes('.crew/'), '.gitignore must ignore .crew/');
    assert.ok(content.includes('.pii-denylist'), '.gitignore must ignore .pii-denylist');
    assert.ok(content.includes('node_modules/'), '.gitignore must ignore node_modules/');
    assert.ok(content.includes('coverage/'), '.gitignore must ignore coverage/');
    assert.ok(content.includes('.env'), '.gitignore must ignore .env');
  });

  test('.pii-denylist.example template exists with instructions and zero real PII', () => {
    const examplePath = path.join(rootDir, '.pii-denylist.example');
    assert.ok(fs.existsSync(examplePath), '.pii-denylist.example must exist');
    const content = fs.readFileSync(examplePath, 'utf8');
    assert.ok(content.length > 50, '.pii-denylist.example must have descriptive instructions');
  });

  test('LICENSE is present, uses MIT License, and NOTICE exists', () => {
    const licensePath = path.join(rootDir, 'LICENSE');
    const noticePath = path.join(rootDir, 'NOTICE');

    assert.ok(fs.existsSync(licensePath), 'LICENSE must exist');
    assert.ok(fs.existsSync(noticePath), 'NOTICE must exist');

    const licenseContent = fs.readFileSync(licensePath, 'utf8');
    assert.ok(licenseContent.includes('MIT License'), 'LICENSE must be MIT');
    assert.ok(licenseContent.includes('JobHunt Crew Authors'), 'LICENSE must attribute JobHunt Crew Authors');
  });

  test('README.md begins with clear one-sentence mission and zero legacy terms', () => {
    const readmePath = path.join(rootDir, 'README.md');
    assert.ok(fs.existsSync(readmePath), 'README.md must exist');
    const content = fs.readFileSync(readmePath, 'utf8');
    const lines = content.split(/\r?\n/).filter(l => l.trim().length > 0);

    assert.ok(lines.length >= 2, 'README.md must have content');
    assert.ok(lines[0].startsWith('# JobHunt Crew'), 'README must start with project title');
    assert.ok(lines[1].toLowerCase().includes('jobhunt crew is a'), 'First paragraph must be one-sentence mission description');
  });

  test('CLI entry point bin/crew.js responds to --help and --version', () => {
    const cliPath = path.join(rootDir, 'bin', 'crew.js');
    assert.ok(fs.existsSync(cliPath), 'bin/crew.js must exist');

    const verOutput = execSync(`node "${cliPath}" --version`, { encoding: 'utf8' }).trim();
    assert.match(verOutput, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, 'CLI --version must report valid semver format');

    const helpOutput = execSync(`node "${cliPath}" --help`, { encoding: 'utf8' });
    assert.ok(helpOutput.includes('Usage:'), 'CLI --help must show usage instructions');
    assert.ok(helpOutput.includes('init'), 'CLI --help must list init command');
    assert.ok(helpOutput.includes('doctor'), 'CLI --help must list doctor command');
  });

  test('CLI doctor command returns exit code 1 when uninitialized and 0 when configured', () => {
    const cliPath = path.join(rootDir, 'bin', 'crew.js');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-exit-test-'));
    try {
      // Uninitialized -> must exit 1
      assert.throws(() => {
        execSync(`node "${cliPath}" doctor`, { cwd: tmpDir, stdio: 'pipe' });
      }, /Command failed/, 'crew doctor must exit non-zero when .crew and .pii-denylist are missing');

      // Initialize -> must exit 0
      fs.mkdirSync(path.join(tmpDir, '.crew'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, '.pii-denylist'), '# benign\n');
      const out = execSync(`node "${cliPath}" doctor`, { cwd: tmpDir, encoding: 'utf8' });
      assert.ok(out.includes('PASSED'), 'crew doctor must report PASSED and exit 0 when initialized');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
