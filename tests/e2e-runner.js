#!/usr/bin/env node
/**
 * JobHunt Crew — Master Test Suite Runner
 *
 * Runs all unit and integration test suites sequentially,
 * aggregating assertion counts, execution times, and exit statuses.
 *
 * Zero external dependencies. Uses Node.js built-in runtime.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const SUITES = [
  { name: 'M1 Layout & Anti-Patterns', file: path.join(__dirname, 'unit', 'test-layout.js') },
  { name: 'M1 JavaScript Syntax Check', file: path.join(__dirname, 'unit', 'test-syntax.js') },
  { name: 'M1 Package Manifest Check', file: path.join(__dirname, 'unit', 'test-manifest.js') },
  { name: 'M1 Verification Scripts', file: path.join(__dirname, 'integration', 'test-scripts.js') },
  { name: 'M2 Core Event Ledger & Reducer', file: path.join(__dirname, 'tier1-feature-coverage', 'test-core-ledger.js') },
  { name: 'M2 Deterministic Guardrails', file: path.join(__dirname, 'tier1-feature-coverage', 'test-guardrails.js') },
  { name: 'M2 Concurrency & Lock Contention', file: path.join(__dirname, 'tier2-boundary-corners', 'test-concurrent-writers.js') },
  { name: 'M2 Canonical Dedup & Fingerprinting', file: path.join(__dirname, 'tier2-boundary-corners', 'test-dedup-edge-cases.js') },
  { name: 'M2 Duplicate Application Guard', file: path.join(__dirname, 'tier3-interactions', 'test-duplicate-application-guard.js') },
  { name: 'M2/M3 Extended CLI & Native MCP Server', file: path.join(__dirname, 'integration', 'test-cli-mcp.js') },
  { name: 'M3 Candidate Dossier & Intake Wizard', file: path.join(__dirname, 'unit', 'test-dossier-and-wizard.js') },
  { name: 'M3 Multi-Format Document Generator', file: path.join(__dirname, 'tier1-feature-coverage', 'test-doc-generator.js') },
  { name: 'M3 Blind Review Panel', file: path.join(__dirname, 'tier1-feature-coverage', 'test-blind-review.js') },
  { name: 'M3 Honest-CV Verifier & Golden Corpus', file: path.join(__dirname, 'tier1-feature-coverage', 'test-honest-cv-verifier.js') },
  { name: 'M3 Verifier Held-Out Boundary Suite', file: path.join(__dirname, 'tier2-boundary-corners', 'test-verifier-held-out.js') },
  { name: 'M3 Verifier Lead Probe Boundary Suite', file: path.join(__dirname, 'tier2-boundary-corners', 'test-verifier-lead-probe.js') },
  { name: 'M3 Self-Learning Editorial Rules', file: path.join(__dirname, 'tier3-interactions', 'test-editorial-rules-lifecycle.js') },
  { name: 'M3 Multi-Vacancy Strategy', file: path.join(__dirname, 'tier3-interactions', 'test-multi-vacancy-strategy.js') },
  { name: 'M3 Tailoring & Review Cycle', file: path.join(__dirname, 'tier3-interactions', 'test-tailor-verify-review-cycle.js') },
  { name: 'M4 Multi-Channel Discovery Adapters', file: path.join(__dirname, 'tier1-feature-coverage', 'test-discovery-adapters.js') },
  { name: 'M4 Multi-Channel Discovery Engine', file: path.join(__dirname, 'tier1-feature-coverage', 'test-discovery-engine.js') },
  { name: 'M4 Rate Limit & Backoff Boundary', file: path.join(__dirname, 'tier2-boundary-corners', 'test-rate-limit-backoff.js') },
  { name: 'M4 Vacancy Age Boundary Suite', file: path.join(__dirname, 'tier2-boundary-corners', 'test-vacancy-age-boundary.js') },
  { name: 'M4 Discovery to Triage Pipeline', file: path.join(__dirname, 'tier3-interactions', 'test-discovery-to-triage.js') },
  { name: 'M4 Challenger Boundary & Linguistic Suite', file: path.join(__dirname, 'tier2-boundary-corners', 'test-m4-challenger-boundary-linguistic.js') },
  { name: 'M4 Iteration 2 Adversarial Stress Suite', file: path.join(__dirname, 'tier2-boundary-corners', 'test-m4-iter2-challenger.js') },
  { name: 'M5 Agent Prompt Definitions', file: path.join(__dirname, 'tier1-feature-coverage', 'test-agent-prompts.js') },
  { name: 'M5 Antigravity Task Sidecars', file: path.join(__dirname, 'tier1-feature-coverage', 'test-antigravity-tasks.js') },
  { name: 'M5 Claude Code Plugin Compiler', file: path.join(__dirname, 'tier1-feature-coverage', 'test-claude-plugin-compiler.js') },
  { name: 'M5 Crew Doctor Diagnostics Subsystem', file: path.join(__dirname, 'tier1-feature-coverage', 'test-crew-doctor.js') },
  { name: 'M5 Cadence Engine & Scam Triage', file: path.join(__dirname, 'tier1-feature-coverage', 'test-cadence-and-scam.js') },
  { name: 'M5 STAR+R Interview Story Bank', file: path.join(__dirname, 'tier1-feature-coverage', 'test-interview-story-bank.js') },
  { name: 'M5 KSA Labor Law Offer Calculator', file: path.join(__dirname, 'tier1-feature-coverage', 'test-ksa-offer-calculator.js') },
  { name: 'M5 Targeted Outreach Generator', file: path.join(__dirname, 'tier1-feature-coverage', 'test-outreach-generator.js') },
  { name: 'M5 Adversarial Stress & Subsystem Invariants Suite', file: path.join(__dirname, 'tier2-boundary-corners', 'test-m5-adversarial-challenger.js') },
  { name: 'M5 Iteration 1 Adversarial Stress Suite', file: path.join(__dirname, 'tier2-boundary-corners', 'test-m5-iter1-adversarial-stress.js') },
  { name: 'M6 Command Center Server & Security', file: path.join(__dirname, 'tier1-feature-coverage', 'test-command-center.js') },
  { name: 'M6 Command Center Server & REST API Full Matrix', file: path.join(__dirname, 'tier1-feature-coverage', 'test-command-center-server.js') },
  { name: 'M6 Command Center Offline Exporter', file: path.join(__dirname, 'tier1-feature-coverage', 'test-command-center-export.js') },
  { name: 'M6 Full HTTP Human Decision Lifecycle', file: path.join(__dirname, 'tier3-interactions', 'test-human-decision-flow.js') },
  { name: 'M6 Adversarial Security & Loopback Isolation Suite', file: path.join(__dirname, 'tier2-boundary-corners', 'test-m6-adversarial-security.js') },
  { name: 'M6 Adversarial Exporter, Script Breakout & UI Invariants Suite', file: path.join(__dirname, 'tier2-boundary-corners', 'test-m6-adversarial-exporter.js') },
  { name: 'M7 Gemini Desktop Companion & Proposal Bridge', file: path.join(__dirname, 'tier1-feature-coverage', 'test-gemini-companion.js') },
  { name: 'M7 Companion Adversarial & Boundary Suite', file: path.join(__dirname, 'tier2-boundary-corners', 'test-m7-adversarial-companion.js') },
  { name: 'M7 Adversarial Stress & Proposal Bridge Invariants', file: path.join(__dirname, 'tier2-boundary-corners', 'test-m7-adversarial-challenger.js') },
  { name: 'M7 Security & Invariant Deep Probe Matrix', file: path.join(__dirname, 'tier2-boundary-corners', 'test-m7-iter4-deep-probe.js') },
  { name: 'M7 Adversarial Age Invariant & False-Positive Stress', file: path.join(__dirname, 'tier2-boundary-corners', 'test-m7-iter5-adversarial-age-stress.js') },
  { name: 'M8 Capability Checklist & Acceptance Mapping Validator', file: path.join(__dirname, 'integration', 'test-capability-checklist.js') },
  { name: 'M8 Deterministic Packaging & Capabilities Verification', file: path.join(__dirname, 'integration', 'test-packaging-and-capabilities.js') },
  { name: 'Tier 4 Full Job Search Simulation', file: path.join(__dirname, 'tier4-real-world', 'test-full-job-search-lifecycle.js') },
  // --- Formerly orphaned suites (Workstream E consolidation) ---
  // NOTE: tier2-boundary-corners/test-branch-trace.js is intentionally absent:
  // it is a helper library (exports instrumentedSafeMoveFile) exercised by
  // run-branch-race.js below, not a standalone suite.
  { name: 'Tier 1 Crew Dispatch', file: path.join(__dirname, 'tier1-feature-coverage', 'test-crew-dispatch.js') },
  { name: 'Tier 2 Verifier Challenger Deep Stress', file: path.join(__dirname, 'tier2-boundary-corners', 'test-verifier-challenger-deep-stress.js') },
  { name: 'Tier 2 Verifier Challenger Novel Probes', file: path.join(__dirname, 'tier2-boundary-corners', 'test-verifier-challenger-novel-probes.js') },
  { name: 'Tier 2 Verifier Lead Probe (Legacy Corner Copy)', file: path.join(__dirname, 'tier2-boundary-corners', 'test-verifier-lead-probe-legacy-corner.js') },
  { name: 'Tier 2 Empty & Malformed Inputs', file: path.join(__dirname, 'tier2-boundary-corners', 'test-empty-and-malformed.js') },
  { name: 'Tier 2 M4 Adversarial Challenger', file: path.join(__dirname, 'tier2-boundary-corners', 'test-m4-adversarial-challenger.js') },
  { name: 'Tier 2 M4 Iter3 Adversarial Empirical', file: path.join(__dirname, 'tier2-boundary-corners', 'test-m4-iter3-adversarial-empirical.js') },
  { name: 'Tier 2 M6 Stress Serialize', file: path.join(__dirname, 'tier2-boundary-corners', 'test-m6-stress-serialize.js') },
  { name: 'Tier 2 M7 Challenger2 Empirical Probe', file: path.join(__dirname, 'tier2-boundary-corners', 'test-m7-challenger2-empirical-probe.js') },
  { name: 'Tier 2 M7 Iter2 Concurrency Stress', file: path.join(__dirname, 'tier2-boundary-corners', 'test-m7-iter2-concurrency-stress.js') },
  { name: 'Tier 2 M7 Iter3 Independent Probe', file: path.join(__dirname, 'tier2-boundary-corners', 'test-m7-iter3-independent-probe.js') },
  { name: 'Tier 2 M8 Packaging Stress Challenger', file: path.join(__dirname, 'tier2-boundary-corners', 'test-m8-packaging-stress-challenger.js') },
  { name: 'Tier 2 Verifier Downscoping Boundary Challenger', file: path.join(__dirname, 'tier2-boundary-corners', 'test-verifier-downscoping-boundary-challenger.js') },
  { name: 'Tier 4 Backup & Restore Lifecycle', file: path.join(__dirname, 'tier4-real-world', 'test-backup-restore-lifecycle.js') },
  { name: 'Tier 4 Clean-Room & PII Gates', file: path.join(__dirname, 'tier4-real-world', 'test-clean-room-and-pii.js') },
  { name: 'Integration Challenger M2 Probe', file: path.join(__dirname, 'integration', 'challenger-m2-probe.js') },
  { name: 'Integration Stress M1 Challenger', file: path.join(__dirname, 'integration', 'stress-m1-challenger.js') },
  { name: 'Integration Stress M2 Challenger', file: path.join(__dirname, 'integration', 'stress-m2-challenger.js') },
  { name: 'Integration Stress M2 Concurrency Recovery', file: path.join(__dirname, 'integration', 'stress-m2-concurrency-recovery.js') },
  { name: 'Integration Stress M2 Iter2 Adversarial Bypasses', file: path.join(__dirname, 'integration', 'stress-m2-iter2-adversarial-bypasses.js') },
  { name: 'Integration Stress M2 Iter4 Challenger', file: path.join(__dirname, 'integration', 'stress-m2-iter4-challenger.js') },
  { name: 'Integration Stress M3 Iter4 Challenger', file: path.join(__dirname, 'integration', 'stress-m3-iter4-challenger.js') },
  // Script-style probes: no suite export, verdict is the process exit code.
  { name: 'Tier 2 M6 Stress Bot Submissions', file: path.join(__dirname, 'tier2-boundary-corners', 'test-m6-stress-bot-submissions.js'), subprocess: true },
  { name: 'Tier 2 Branch Race Probe', file: path.join(__dirname, 'tier2-boundary-corners', 'run-branch-race.js'), subprocess: true },
  { name: 'Challenger M4 Iter2 Stress', file: path.join(__dirname, 'challenger-m4-iter2-stress.js'), subprocess: true },
  { name: 'Integration Challenger M2 Iter3 Active PID Lock', file: path.join(__dirname, 'integration', 'challenger-m2-iter3-active-pid-lock-test.js'), subprocess: true },
  { name: 'Integration Challenger M2 Iter3 Live Probes', file: path.join(__dirname, 'integration', 'challenger-m2-iter3-live-probes.js'), subprocess: true },
  { name: 'Integration Challenger M2 Iter4 Verification', file: path.join(__dirname, 'integration', 'challenger-m2-iter4-verification.js'), subprocess: true },
  { name: 'Integration Challenger M3 Iter2 Adversarial Probes', file: path.join(__dirname, 'integration', 'challenger-m3-iter2-adversarial-probes.js'), subprocess: true },
  { name: 'Integration Challenger M8 Packaging Stress', file: path.join(__dirname, 'integration', 'challenger-m8-packaging-stress.js'), subprocess: true },
  { name: 'Integration Challenger Sentinel Probe', file: path.join(__dirname, 'integration', 'challenger-sentinel-probe.js'), subprocess: true }
];

async function runSuite(suite) {
  const startTime = Date.now();
  console.log(`\n>>> RUNNING SUITE: ${suite.name}`);
  console.log(`    File: ${path.relative(path.resolve(__dirname, '..'), suite.file)}`);

  if (!fs.existsSync(suite.file)) {
    console.error(`    ERROR: Suite file does not exist: ${suite.file}`);
    return { name: suite.name, passed: 0, failed: 1, duration: 0, err: new Error('File not found') };
  }

  let passed = 0;
  let failed = 0;
  let error = null;

  if (suite.subprocess) {
    const result = spawnSync(process.execPath, [suite.file], {
      encoding: 'utf8',
      timeout: 180000,
      maxBuffer: 16 * 1024 * 1024
    });
    if (result.error) {
      failed = 1;
      error = result.error;
      console.error(`    FAILED: ${result.error.message}`);
    } else if (result.status === 0) {
      passed = 1;
    } else {
      failed = 1;
      error = new Error(`Subprocess exited with code ${result.status}`);
      const tail = `${result.stdout || ''}\n${result.stderr || ''}`.trim().split('\n').slice(-8);
      for (const line of tail) console.error(`    ${line}`);
    }
    const duration = Date.now() - startTime;
    console.log(`    Result: ${failed === 0 ? 'PASS' : 'FAIL'} (${passed} passed, ${failed} failed in ${duration}ms)`);
    return { name: suite.name, passed, failed, duration, error };
  }

  try {
    const mod = require(suite.file);
    const runner = typeof mod.run === 'function' ? mod : (mod.suite && typeof mod.suite.run === 'function' ? mod.suite : null);
    if (runner) {
      const stats = await runner.run();
      passed = stats.passed || 0;
      failed = stats.failed || 0;
      if (stats.errors && stats.errors.length > 0) {
        for (const e of stats.errors) {
          console.error(`    FAILED TEST: ${e.test}`);
          console.error(`      ${e.error && e.error.message}`);
          if (e.error && e.error.stack) {
            console.error(`      ${e.error.stack.split('\n').slice(1, 4).join('\n      ')}`);
          }
        }
      }
    } else {
      passed = 1;
    }
  } catch (err) {
    failed++;
    error = err;
    console.error(`    FAILED: ${err.message}`);
    if (err.stack) {
      console.error(`    ${err.stack.split('\n').slice(1, 4).join('\n    ')}`);
    }
  }

  const duration = Date.now() - startTime;
  console.log(`    Result: ${failed === 0 ? 'PASS' : 'FAIL'} (${passed} passed, ${failed} failed in ${duration}ms)`);
  return { name: suite.name, passed, failed, duration, error };
}

async function main() {
  const globalStart = Date.now();
  console.log('======================================================================');
  console.log('JOBHUNT CREW — AUTOMATED TEST SUITE RUNNER');
  console.log('======================================================================');

  let totalPassed = 0;
  let totalFailed = 0;
  const results = [];

  for (const suite of SUITES) {
    const res = await runSuite(suite);
    results.push(res);
    totalPassed += res.passed;
    totalFailed += res.failed;
  }

  const totalDuration = Date.now() - globalStart;

  console.log('\n======================================================================');
  console.log('TEST EXECUTION SUMMARY');
  console.log('======================================================================');
  for (const r of results) {
    const mark = r.failed === 0 ? '✓' : '✖';
    console.log(`  ${mark} ${r.name.padEnd(35)} : ${r.passed} passed, ${r.failed} failed (${r.duration}ms)`);
  }
  console.log('----------------------------------------------------------------------');
  console.log(`Total Checks : ${totalPassed + totalFailed} | Passed: ${totalPassed} | Failed: ${totalFailed}`);
  console.log(`Total Time   : ${totalDuration}ms`);

  if (totalFailed === 0) {
    console.log('>>> ALL VERIFICATION SUITES PASSED (EXIT 0) <<<');
    console.log('======================================================================');
    process.exit(0);
  } else {
    console.log('>>> TEST SUITE FAILURES DETECTED (EXIT 1) <<<');
    console.log('======================================================================');
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { main, SUITES, runSuite };
