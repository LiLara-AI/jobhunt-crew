'use strict';

/**
 * The engine enforces what the skills promise: no pack on a failed claim
 * check, a cover letter file from supplied text, a resume reader limited to
 * the workspace, and sector exclusions applied by job scoring.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { McpServer } = require('../../lib/mcp/server');

const CLI = path.resolve(__dirname, '../../bin/crew.js');
const { loadTriageProfile } = require('../../lib/cli/commands/job');
const { JobScorer } = require('../../lib/discovery/job-scorer');

const EXAMPLE = path.resolve(__dirname, '../../templates/CareerDossier.example.json');
const GOOD = 'Architected event-driven microservices processing 12,000 requests per second with sub-50ms latency at Apex Cloud Technologies.';
const BAD = 'Grew revenue by 900% as Chief Executive Officer at Nowhere Holdings.';

async function workspace() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-gates-'));
  fs.copyFileSync(EXAMPLE, path.join(ws, 'dossier.json'));
  const server = new McpServer({ workspace: ws });
  await server.callTool('crew_record_event', {
    type: 'JOB_DISCOVERED',
    payload: { id: 'job_1', title: 'Staff Engineer', company: 'Acme', url: 'https://careers.example.org/1' }
  });
  return { ws, server };
}

test('apply pack reports what is missing, refuses a failed claim check, and writes the cover letter', async () => {
  const { ws, server } = await workspace();
  try {
    // A verdict passed as an argument is not a recorded review.
    const draft = await server.callTool('crew_apply_pack', { job_id: 'job_1', review_verdict: { verdict: 'APPROVE' } });
    assert.equal(draft.blockers.length, 2, 'nothing recorded yet: both checks are named');
    assert.equal(draft.status, 'blocked');
    assert.match(fs.readFileSync(draft.filePath, 'utf8'), /Status\*\*: `blocked`/);

    assert.equal((await server.callTool('crew_verify_draft', { draft_path: BAD, job_id: 'job_1' })).passed, false);
    await assert.rejects(server.callTool('crew_apply_pack', { job_id: 'job_1' }), /GUARDRAIL_VIOLATION: Claim verification FAILED/);
    // The CLI command applies the same gate as the tool.
    const cli = spawnSync(process.execPath, [CLI, 'apply-pack', '--job-id', 'job_1', '--workspace', ws], { encoding: 'utf8' });
    assert.equal(cli.status, 1);
    assert.match(cli.stderr, /GUARDRAIL_VIOLATION: Claim verification FAILED/);

    assert.equal((await server.callTool('crew_verify_draft', { draft_path: GOOD, job_id: 'job_1' })).passed, true);
    await server.callTool('crew_review_record', { job_id: 'job_1', verdict: 'APPROVE', overall_score: 4.5 });
    // A letter with an unsupported fact is refused even though the job's last check passed.
    await assert.rejects(server.callTool('crew_apply_pack', { job_id: 'job_1', cover_letter_text: BAD }), /cover_letter_text failed claim verification/);

    const pack = await server.callTool('crew_apply_pack', {
      job_id: 'job_1', claims_used: ['C-01'], cover_letter_text: 'Dear hiring team,\n\nPlease find my application attached.'
    });
    assert.deepEqual(pack.blockers, []);
    assert.equal(pack.status, 'ready-to-submit');
    assert.equal(pack.artifacts.coverLetterDocx, 'CoverLetter_Acme_Staff_Engineer.docx');
    const letter = path.join(path.dirname(pack.filePath), pack.artifacts.coverLetterDocx);
    assert.ok(fs.statSync(letter).size > 500);
    assert.doesNotMatch(fs.readFileSync(pack.filePath, 'utf8'), /No cover letter file yet|NOT RUN|blocked/);

    // Rebuilding with the same letter is not a blocker.
    const same = await server.callTool('crew_apply_pack', {
      job_id: 'job_1', claims_used: ['C-01'], cover_letter_text: 'Dear hiring team,\n\nPlease find my application attached.'
    });
    assert.deepEqual([same.status, same.blockers], ['ready-to-submit', []]);

    // A hand-edited letter is kept on rebuild, and the pack says so.
    fs.writeFileSync(letter, 'edited by hand');
    const again = await server.callTool('crew_apply_pack', { job_id: 'job_1', cover_letter_text: 'Dear team,\n\nA newer letter.' });
    assert.equal(fs.readFileSync(letter, 'utf8'), 'edited by hand');
    assert.equal(again.status, 'blocked', 'an unsaved letter must not look ready');
    assert.ok(again.blockers.some(b => /was NOT saved/.test(b)));
    assert.equal((await server.callTool('crew_apply_pack', { job_id: 'job_1' })).status, 'ready-to-submit');
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('crew_read_resume reads workspace resumes only', async () => {
  const { ws, server } = await workspace();
  const outside = path.join(os.tmpdir(), `crew-gates-outside-${process.pid}.txt`);
  try {
    fs.writeFileSync(path.join(ws, 'resume.md'), '# Jane Doe\nSenior Accountant', 'utf8');
    fs.writeFileSync(path.join(ws, 'secrets.env'), 'TOKEN=1', 'utf8');
    fs.writeFileSync(outside, 'outside', 'utf8');
    assert.match((await server.callTool('crew_read_resume', { file: 'resume.md' })).text, /Senior Accountant/);
    await assert.rejects(server.callTool('crew_read_resume', { file: outside }), /inside the workspace/);
    await assert.rejects(server.callTool('crew_read_resume', { file: '../x.txt' }), /inside the workspace/);
    await assert.rejects(server.callTool('crew_read_resume', { file: 'secrets.env' }), /Unsupported resume file type/);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
    fs.rmSync(outside, { force: true });
  }
});

test('sector exclusions from search-config.json knock a matching posting out', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-gates-'));
  try {
    fs.writeFileSync(path.join(ws, 'search-config.json'), JSON.stringify({
      targetTitles: ['Accountant'],
      knockouts: { excludedCompanies: [], excludedIndustries: ['Insurance'], seniorityFloor: '' }
    }), 'utf8');
    const { preferences, skills } = loadTriageProfile(ws);
    const job = { title: 'Accountant', company: 'Example Insurance Co', location: 'Riyadh' };
    const hit = JobScorer.scoreVacancy(job, preferences, skills);
    assert.equal(hit.knockout, 'EXCLUDED_INDUSTRY');
    assert.equal(hit.shortlisted, false);
    assert.match(hit.rationale, /excluded sector "Insurance"/);
    // A benefit named in the description is not the employer's sector.
    const miss = JobScorer.scoreVacancy({ ...job, company: 'Example Co', description: 'Benefits: medical insurance for your family.' }, preferences, skills);
    assert.notEqual(miss.knockout, 'EXCLUDED_INDUSTRY');
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('a backup written by the tool stays in the workspace, and a restore keeps the profile it replaces', async () => {
  const { ws, server } = await workspace();
  try {
    await assert.rejects(server.callTool('crew_backup', { out_file: path.join(os.tmpdir(), 'crew-gates-leak.json') }), /inside the workspace/);
    const backup = await server.callTool('crew_backup', { out_file: 'my-backup.json' });
    assert.deepEqual(backup.workspaceFiles, ['dossier.json']);
    fs.writeFileSync(path.join(ws, 'dossier.json'), '{"claims":[]}', 'utf8');
    await server.callTool('crew_restore', { file: 'my-backup.json' });
    assert.equal(fs.readFileSync(path.join(ws, 'dossier.json.pre-restore'), 'utf8'), '{"claims":[]}');
    assert.equal(fs.readFileSync(path.join(ws, 'dossier.json'), 'utf8'), fs.readFileSync(EXAMPLE, 'utf8'));
    // A second restore must not overwrite the first safety copy.
    fs.writeFileSync(path.join(ws, 'dossier.json'), '{"claims":[1]}', 'utf8');
    await server.callTool('crew_restore', { file: 'my-backup.json' });
    assert.equal(fs.readFileSync(path.join(ws, 'dossier.json.pre-restore'), 'utf8'), '{"claims":[]}');
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('a job marked ready needs no further checks, and an unrecorded verdict is labelled', async () => {
  const { ws, server } = await workspace();
  try {
    const unrecorded = await server.callTool('crew_apply_pack', { job_id: 'job_1', review_verdict: { verdict: 'APPROVE', overallScore: 4.8 } });
    assert.match(fs.readFileSync(unrecorded.filePath, 'utf8'), /Blind review: APPROVE \(not recorded\)/);
    await server.callTool('crew_record_event', {
      type: 'PACKAGE_MARKED_READY',
      payload: { jobId: 'job_1', claimVerification: { passed: true, violations: [] }, reviewPanel: { verdict: 'APPROVE' } }
    });
    const ready = await server.callTool('crew_apply_pack', { job_id: 'job_1' });
    assert.deepEqual([ready.status, ready.blockers], ['ready-to-submit', []]);
    await assert.rejects(server.callTool('crew_record_event', { type: 'CLAIMS_VERIFIED', payload: { jobId: '__proto__', passed: true } }), /cannot be used as a job id/);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('a recorded review that is not APPROVE blocks the pack, whatever verdict is passed in', async () => {
  const { ws, server } = await workspace();
  try {
    await server.callTool('crew_verify_draft', { draft_path: GOOD, job_id: 'job_1' });
    await server.callTool('crew_review_record', { job_id: 'job_1', verdict: 'REQUEST_CHANGES', overall_score: 2.1 });
    const pack = await server.callTool('crew_apply_pack', { job_id: 'job_1', review_verdict: { verdict: 'APPROVE', overallScore: 4.9 } });
    assert.equal(pack.status, 'blocked');
    assert.equal(pack.blockers.length, 1);
    const md = fs.readFileSync(pack.filePath, 'utf8');
    assert.match(md, /Blind review: REQUEST_CHANGES/);
    assert.doesNotMatch(md, /Blind review: APPROVE|4\.9 \/ 5\.0/);
    // Exact match: a verdict that merely contains APPROVE is not an approval.
    const { ApplyPackGenerator } = require('../../lib/honest-cv/apply-pack');
    const recorded = ApplyPackGenerator.checksFromApplication({ verification: { passed: true }, review: { verdict: 'APPROVE_WITH_CHANGES' } });
    assert.equal(ApplyPackGenerator.submissionBlockers(recorded).length, 1);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('a FOLLOW_UP_SENT the reducer would ignore is refused by the tool and by crew ledger append', async () => {
  const { ws, server } = await workspace();
  try {
    // job_1 is discovered but has no application yet.
    await assert.rejects(server.callTool('crew_record_event', { type: 'FOLLOW_UP_SENT', payload: { jobId: 'job_1', day: 7 } }), /tracked application/);
    await server.callTool('crew_verify_draft', { draft_path: GOOD, job_id: 'job_1' });
    const cli = spawnSync(process.execPath, [CLI, 'ledger', 'append', '--event', 'FOLLOW_UP_SENT',
      '--payload', JSON.stringify({ jobId: 'job_1', day: 3 }), '--workspace', ws], { encoding: 'utf8' });
    assert.equal(cli.status, 1);
    assert.match(cli.stderr, /day 7 or 14/);
    await server.callTool('crew_record_event', { type: 'FOLLOW_UP_SENT', payload: { jobId: 'job_1', day: 7 } });
    const snapshot = JSON.parse(fs.readFileSync(path.join(ws, '.crew', 'snapshot.json'), 'utf8'));
    assert.deepEqual(snapshot.applications.job_1.followUps, { day7: true });
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('crew_read_resume refuses a link that leads outside the workspace and a file over 5 MB', async () => {
  const { ws, server } = await workspace();
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-gates-outside-'));
  try {
    fs.writeFileSync(path.join(outsideDir, 'resume.md'), 'outside', 'utf8');
    fs.symlinkSync(outsideDir, path.join(ws, 'linked'), 'junction');
    await assert.rejects(server.callTool('crew_read_resume', { file: 'linked/resume.md' }), /inside the workspace/);
    fs.writeFileSync(path.join(ws, 'big.txt'), Buffer.alloc(5 * 1024 * 1024 + 1, 'a'));
    await assert.rejects(server.callTool('crew_read_resume', { file: 'big.txt' }), /larger than 5 MB/);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  }
});
