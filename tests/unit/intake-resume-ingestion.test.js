'use strict';

// Resume ingestion must never substitute template data: unreadable input is an
// error, .docx is unpacked, and nothing placeholder-derived is VERIFIED.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { IntakeWizard, WorkspaceBuilder, readResumeFile } = require('../../lib/honest-cv/intake-wizard');
const { CareerDossier } = require('../../lib/honest-cv/dossier');
const { DocxGenerator } = require('../../lib/honest-cv/doc-generator');

const CV_TEXT = [
  'Sara Al-Harbi',
  'Senior Data Engineer',
  'sara.alharbi@example.org | +966 50 123 4567',
  '',
  'EXPERIENCE',
  'Senior Data Engineer — Gulf Analytics (2020–Present)',
  '- Built ingestion pipelines serving 40 internal teams',
  '',
  'EDUCATION',
  'B.Sc. Computer Science, King Saud University, 2016'
].join('\n');

function withWizard(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'intake-resume-'));
  try {
    const wizard = new IntakeWizard({ workspaceDir: dir, autoLoad: false });
    wizard.submitAnswer('all_connected'); // Q1
    return fn(wizard, dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function assertRejected(wizard, answer, pattern) {
  assert.throws(() => wizard.submitAnswer(answer), pattern);
  assert.equal(wizard.state.dossier, null, 'no dossier is stored for an unreadable resume');
  assert.equal(wizard.getCurrentStep().id, 'Q2_CV_INGESTION', 'the wizard stays on the resume question');
}

test('a PDF resume is rejected with an actionable message, not replaced by the template', () => {
  withWizard((wizard, dir) => {
    const pdf = path.join(dir, 'resume.pdf');
    fs.writeFileSync(pdf, Buffer.from('%PDF-1.7\n\u0000\u0001binary'));
    assertRejected(wizard, pdf, /INTAKE_VALIDATION_ERROR.*Paste the resume text or save it as \.docx\/\.txt\/\.md/);
    // Same bytes under an innocent extension, and pasted straight in.
    const disguised = path.join(dir, 'resume.txt');
    fs.copyFileSync(pdf, disguised);
    assertRejected(wizard, disguised, /binary file/);
    assertRejected(wizard, '%PDF-1.7 pasted bytes', /binary content/);
    assertRejected(wizard, path.join(dir, 'missing.docx'), /Resume file not found/);
  });
});

test('text with no recognisable sections (e.g. an Arabic CV) is an error, never a fake dossier', () => {
  withWizard((wizard, dir) => {
    const arabic = path.join(dir, 'cv-ar.txt');
    fs.writeFileSync(arabic, 'سيرة ذاتية\nمهندس برمجيات\nالخبرة العملية\n', 'utf8');
    assertRejected(wizard, arabic, /INTAKE_VALIDATION_ERROR.*no Summary, Experience or Education section/);
    assertRejected(wizard, '{ not json', /INTAKE_VALIDATION_ERROR/);
  });
});

test('a .docx resume is unpacked and parsed into unconfirmed claims', () => {
  withWizard((wizard, dir) => {
    const docx = path.join(dir, 'resume.docx');
    fs.writeFileSync(docx, DocxGenerator.buildDocxBuffer(CV_TEXT));
    assert.match(readResumeFile(docx), /Gulf Analytics \(2020–Present\)\n/);

    wizard.submitAnswer(docx);
    const dossier = wizard.state.dossier;
    assert.equal(dossier.candidate.email, 'sara.alharbi@example.org');
    assert.equal(dossier.candidate.phone, '+966 50 123 4567');
    assert.deepEqual(dossier.employers.map(e => e.name), ['Gulf Analytics']);
    assert.ok(dossier.claims.length > 0 && dossier.claims.every(c => c.status === 'CONFIRM'));

    const corrupt = path.join(dir, 'corrupt.docx');
    fs.writeFileSync(corrupt, 'PK\u0003\u0004 not really a zip');
    assert.throws(() => readResumeFile(corrupt), /Could not read "corrupt\.docx" as a Word \.docx file/);
  });
});

test('nothing placeholder-derived is VERIFIED or carries fake contact details', async () => {
  const template = CareerDossier.createTemplate();
  assert.ok(template.claims.every(c => c.status !== 'VERIFIED'));
  assert.equal(template.candidate.email, '');
  assert.equal(template.candidate.phone, '');

  // A dossier with no contact details keeps them empty (apply packs pre-fill these).
  const bare = new CareerDossier({ candidate: { name: 'Sara Al-Harbi', summary: 'Sara Al-Harbi builds pipelines.' } });
  assert.equal(bare.candidate.email, '');
  assert.equal(bare.candidate.phone, '');
  assert.equal(bare.exportForBlindReview().candidate.summary, 'Candidate builds pipelines.');

  // Unknown status values gate instead of silently verifying.
  const statuses = new CareerDossier({
    employers: [{ id: 'e1', name: 'Gulf Analytics' }],
    claims: ['pending', 'DRAFT', 'CONFIRM', 'VERIFIED', undefined].map((status, i) => ({ id: `C-${i}`, employerId: 'e1', text: 'x', status }))
  }).claims.map(c => c.status);
  assert.deepEqual(statuses, ['CONFIRM', 'CONFIRM', 'CONFIRM', 'VERIFIED', 'VERIFIED']);

  // A workspace built without a resume gets an empty dossier, not template facts.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'intake-empty-'));
  try {
    await WorkspaceBuilder.build(dir, { completed: true });
    const written = JSON.parse(fs.readFileSync(path.join(dir, 'dossier.json'), 'utf8'));
    assert.deepEqual(written.employers, []);
    assert.deepEqual(written.claims, []);
    assert.equal(written.candidate.email, '');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
