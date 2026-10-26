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
  { name: 'M3 Verifier Held-Out Boundary Suite', file: path.join(__dirname, 'tier2-boundary-corner', 'test-verifier-held-out.js') },
  { name: 'M3 Verifier Lead Probe Boundary Suite', file: path.join(__dirname, 'tier2-boundary-corners', 'test-verifier-lead-probe.js') },
  { name: 'M3 Self-Learning Editorial Rules', file: path.join(__dirname, 'tier3-interactions', 'test-editorial-rules-lifecycle.js') },
  { name: 'M3 Multi-Vacancy Strategy', file: path.join(__dirname, 'tier3-interactions', 'test-multi-vacancy-strategy.js') },
  { name: 'M3 Tailoring & Review Cycle', file: path.join(__dirname, 'tier3-interactions', 'test-tailor-verify-review-cycle.js') },
  { name: 'M4 Multi-Channel Discovery Adapters', file: path.join(__dirname, 'tier1-feature-coverage', 'test-discovery-adapters.js') },
  { name: 'M4 Multi-Channel Discovery Engine', file: path.join(__dirname, 'tier1-feature-coverage', 'test-discovery-engine.js') },
  { name: 'M4 Rate Limit & Backoff Boundary', file: path.join(__dirname, 'tier2-boundary-corners', 'test-rate-limit-backoff.js') },
  { name: 'M4 Vacancy Age Boundary Suite', file: path.join(__dirname, 'tier2-boundary-corners', 'test-vacancy-age-boundary.js') },
  { name: 'M4 Discovery to Triage Pipeline', file: path.join(__dirname, 'tier3-interactions', 'test-discovery-to-triage.js') },
  { name: 'M4 Challenger Boundary & Linguistic Suite', file: path.join(__dirname, 'tier2-boundary-corner', 'test-m4-challenger-boundary-linguistic.js') },
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
  { name: 'Tier 4 Full Job Search Simulation', file: path.join(__dirname, 'tier4-real-world', 'test-full-job-search-lifecycle.js') }
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

module.exports = { main };
