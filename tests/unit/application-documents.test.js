'use strict';

/**
 * Application documents a recruiter actually receives: structured CV (DOCX, HTML,
 * fallback PDF), apply-pack files that exist on disk, opt-in RTL, and screening /
 * outreach / multi-vacancy copy derived from the dossier rather than from a
 * software-engineering template.
 */

// Keep headless Chrome/Edge out of unit tests; the built-in PDF writer is exercised instead.
process.env.CREW_NO_BROWSER_PDF = '1';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { DocGenerator } = require('../../lib/honest-cv/doc-generator');
const { ApplyPackGenerator } = require('../../lib/honest-cv/apply-pack');
const { OutreachGenerator } = require('../../lib/crew/outreach');
const { MultiVacancyStrategist } = require('../../lib/honest-cv/multi-vacancy');

const ROOT = path.resolve(__dirname, '../..');
const example = () => JSON.parse(fs.readFileSync(path.join(ROOT, 'templates/CareerDossier.example.json'), 'utf8'));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'crew-docs-'));
const ARABIC_EMPLOYER = String.fromCharCode(0x634, 0x631, 0x643, 0x629); // an Arabic word, built from code points

// A candidate who is not a software engineer.
const nurse = () => ({
  candidate: {
    name: 'Sam Carter', email: 'sam.carter@example.org', phone: '+966 50 000 0000', location: 'Jeddah, Saudi Arabia',
    workAuthorization: 'Transferable Iqama', noticePeriodDays: 60, currentTitle: 'Charge Nurse',
    summary: 'Registered nurse with 8 years of intensive care experience',
    salaryFloor: { currency: 'SAR', minimumBase: 14000, disclosurePolicy: 'mandatory_only' }
  },
  employers: [{ id: 'e1', name: 'Example General Hospital', location: 'Jeddah', startYear: 2019, isCurrent: true, title: 'Charge Nurse' }],
  claims: [
    { id: 'C-01', employerId: 'e1', text: 'Led a 12-bed intensive care unit across rotating shifts.', metrics: ['12 beds'], status: 'VERIFIED' },
    { id: 'C-02', employerId: 'e1', text: 'Cut medication errors by 90%.', metrics: ['90 %'], status: 'CONFIRM' }
  ],
  degrees: [{ degree: 'B.Sc. Nursing', institution: 'Example University', year: 2016 }],
  skills: { clinical: ['ICU nursing', 'Patient care'] },
  preferences: { targetTitles: ['Head Nurse', 'Nurse Manager'] }
});

function documentXml(docx) {
  let off = 0;
  while (docx.readUInt32LE(off) === 0x04034b50) {
    const method = docx.readUInt16LE(off + 8);
    const size = docx.readUInt32LE(off + 18);
    const nameLen = docx.readUInt16LE(off + 26);
    const start = off + 30 + nameLen + docx.readUInt16LE(off + 28);
    const data = docx.subarray(start, start + size);
    if (docx.subarray(off + 30, off + 30 + nameLen).toString() === 'word/document.xml') {
      return (method === 8 ? zlib.inflateRawSync(data) : data).toString('utf8');
    }
    off = start + size;
  }
  throw new Error('word/document.xml not found');
}

// Everything a recruiter or ATS needs from the example dossier, in reading order.
const EXPECTED_ORDER = [
  'Alex Rivera', '+966 55 111 2222', 'alex.rivera@example.org', 'Riyadh, Saudi Arabia',
  'Professional Summary', 'Experience',
  'Apex Cloud Technologies', '2022 - Present', '12,000 requests per second', 'Mentored 6 junior',
  'Oasis Digital Commerce', '2018 - 2022', 'expenditures by 28%',
  'Education', 'B.Sc. Computer Science, Example University (2015)',
  'Certifications', 'AWS Certified Solutions Architect, Amazon Web Services (2023)',
  'Skills', 'PostgreSQL'
];

function assertInOrder(text, label) {
  let from = 0;
  for (const piece of EXPECTED_ORDER) {
    const at = text.indexOf(piece, from);
    assert.ok(at >= 0, `${label}: "${piece}" missing or out of order`);
    from = at + piece.length;
  }
}

test('CV DOCX carries contact details and per-employer history, newest first', () => {
  const dossier = example();
  dossier.employers.reverse(); // order in the dossier must not matter
  dossier.claims.push({ id: 'C-09', employerId: 'emp_02', text: 'Unverified boast about revenue.', status: 'CONFIRM' });
  const xml = documentXml(DocGenerator.generateCvDocx(dossier));
  assertInOrder(xml, 'DOCX');
  assert.match(xml, /<w:pStyle w:val="Heading1"\/>/);
  assert.doesNotMatch(xml, /<w:tbl|\[C-0\d\]|Unverified boast|<w:bidi\/>/);
});

test('CV HTML, the cv-modern template and the fallback PDF carry the same sections', () => {
  const dossier = example();
  const html = DocGenerator.generateCvHtml(dossier);
  assertInOrder(html, 'HTML');
  assert.match(html, /<h2>Professional Summary<\/h2>/);
  assert.doesNotMatch(html, /<table/);

  const template = fs.readFileSync(path.join(ROOT, 'templates/cv-modern.html'), 'utf8');
  const fromTemplate = DocGenerator.generateCvHtml(dossier, { template });
  assertInOrder(fromTemplate, 'cv-modern.html');
  assert.match(fromTemplate, /<html lang="en" dir="ltr">/);
  assert.doesNotMatch(fromTemplate, /\{\{|<table/);

  const pdf = DocGenerator.generateCvPdf(dossier, { quiet: true }).toString('latin1');
  assert.ok(pdf.startsWith('%PDF-') && pdf.trimEnd().endsWith('%%EOF'));
  assertInOrder(pdf.replace(/\\([()\\])/g, '$1').replace('PROFESSIONAL SUMMARY', 'Professional Summary')
    .replace('EXPERIENCE', 'Experience').replace('EDUCATION', 'Education')
    .replace('CERTIFICATIONS', 'Certifications').replace('SKILLS', 'Skills'), 'fallback PDF');
});

test('RTL is opt-in: stray Arabic text never flips a CV, and never yields a corrupt PDF', () => {
  const dossier = example();
  dossier.employers[1].name = ARABIC_EMPLOYER;

  assert.match(DocGenerator.generateCvHtml(dossier), /<html lang="en" dir="ltr">/);
  assert.doesNotMatch(documentXml(DocGenerator.generateCvDocx(dossier)), /<w:bidi\/>/);
  assert.ok(documentXml(DocGenerator.generateCvDocx(dossier)).includes(ARABIC_EMPLOYER));

  assert.match(DocGenerator.generateCvHtml(dossier, { language: 'ar' }), /<html lang="ar" dir="rtl">/);
  const rtlXml = documentXml(DocGenerator.generateCvDocx(dossier, { language: 'ar' }));
  assert.match(rtlXml, /<w:bidi\/>/);
  assert.doesNotMatch(rtlXml, /<w:jc w:val="right"\/>/, 'Word left-aligns a bidi paragraph that carries jc=right');

  // No headless browser here, and Helvetica cannot draw Arabic: fail loudly, point at DOCX/HTML.
  assert.throws(() => DocGenerator.generateCvPdf(dossier, { quiet: true }), /PDF_UNAVAILABLE.*DOCX or HTML/);
  assert.throws(() => DocGenerator.generateCoverLetterPdf(ARABIC_EMPLOYER, { quiet: true }), /PDF_UNAVAILABLE/);
});

test('apply pack writes the CV files it lists and never cites a missing one', () => {
  const ws = tmp();
  try {
    const job = { id: 'job_1', company: 'Acme Health', title: 'Head Nurse', url: 'https://careers.example.org/1' };
    const dossier = nurse();
    // Same call shape as lib/mcp/server.js and lib/cli/commands/crew-ops.js: no dossier in packData.
    const written = ApplyPackGenerator.writeApplyPack(ws, job.company, job.title, {
      screeningAnswers: ApplyPackGenerator.generateScreeningAnswers(dossier, job),
      preFillPlan: ApplyPackGenerator.buildPreFillPlan(job, dossier)
    });
    const md = fs.readFileSync(written.filePath, 'utf8');
    const listed = [...md.matchAll(/\*\*(?:CV|Cover Letter) \((?:DOCX|PDF)\)\*\*: `([^`]+)`/g)].map(m => m[1]);
    assert.deepEqual(listed, ['CV_Acme_Health_Head_Nurse.docx', 'CV_Acme_Health_Head_Nurse.pdf']);
    for (const name of listed) assert.ok(fs.statSync(path.join(written.dir, name)).size > 500, `${name} must exist`);
    assert.match(md, /No cover letter file yet/);
    const xml = documentXml(fs.readFileSync(path.join(written.dir, listed[0])));
    assert.ok(xml.includes('Example General Hospital') && xml.includes('Led a 12-bed'));
    assert.ok(!xml.includes('medication errors'), 'unverified [CONFIRM] claims stay out of the CV');

    // A hand-edited document is never overwritten by a rebuild.
    fs.writeFileSync(path.join(written.dir, listed[0]), 'edited by hand');
    const again = ApplyPackGenerator.writeApplyPack(ws, job.company, job.title, { dossier });
    assert.equal(fs.readFileSync(path.join(written.dir, listed[0]), 'utf8'), 'edited by hand');
    assert.match(fs.readFileSync(again.filePath, 'utf8'), /already existed and was kept/);

    // No dossier: nothing is generated and nothing is cited.
    const bare = ApplyPackGenerator.writeApplyPack(ws, 'Other Co', 'Analyst', {});
    assert.deepEqual(fs.readdirSync(bare.dir), ['apply-pack.md']);
    const bareMd = fs.readFileSync(bare.filePath, 'utf8');
    assert.match(bareMd, /No CV was generated/);
    assert.doesNotMatch(bareMd, /\*\*CV \(/);

    // A failed render is reported in the pack instead of being cited.
    const arabic = nurse();
    arabic.employers[0].name = ARABIC_EMPLOYER;
    const partial = ApplyPackGenerator.writeApplyPack(ws, 'Third Co', 'Nurse', { dossier: arabic });
    assert.deepEqual(Object.keys(partial.artifacts), ['cvDocx']);
    assert.match(fs.readFileSync(partial.filePath, 'utf8'), /CV_Third_Co_Nurse\.pdf` was NOT generated: PDF_UNAVAILABLE/);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('screening answers and pre-fill plan come from the dossier, not a software template', () => {
  const job = { id: 'job_1', company: 'Acme Health', title: 'Head Nurse' };
  const answers = ApplyPackGenerator.generateScreeningAnswers(nurse(), job);
  assert.doesNotMatch(answers.customMotivation, /distributed systems|architecture/i);
  assert.match(answers.customMotivation, /Head Nurse role at Acme Health.*Charge Nurse.*intensive care experience\. .*Led a 12-bed/);
  assert.ok(!answers.customMotivation.includes('medication errors'), 'unverified claims are not quoted');
  assert.equal(answers.noticePeriod, '60 Days');
  assert.equal(ApplyPackGenerator.generateScreeningAnswers({ candidate: {} }, job).noticePeriod, '', 'no invented notice period');

  // mandatory_only: the salary input is skipped, never filled with instructions.
  const plan = ApplyPackGenerator.buildPreFillPlan(job, nurse());
  assert.ok(!plan.fieldMappings.some(m => /salary/.test(m.selector)));
  assert.ok(plan.fieldMappings.every(m => m.value && !/leave blank|optional/i.test(m.value)));
  assert.equal(plan.skippedFields[0].field, 'salary');

  // always_disclose: a bare number, nothing else.
  const open = nurse();
  open.candidate.salaryFloor.disclosurePolicy = 'always_disclose';
  const salary = ApplyPackGenerator.buildPreFillPlan(job, open).fieldMappings.find(m => /salary/.test(m.selector));
  assert.equal(salary.value, '14000');
});

test('outreach uses the real title, a verified claim and candidate.noticePeriodDays', () => {
  const jobRecord = { company: 'Acme Health', title: 'Head Nurse' };
  const draft = persona => OutreachGenerator.generateOutreach({ persona, jobRecord, dossier: nurse() });

  const recruiter = draft('RECRUITER');
  assert.match(recruiter.message, /Charge Nurse/);
  assert.match(recruiter.message, /60-day notice period/);
  assert.doesNotMatch(recruiter.message, /immediate/i);

  const manager = draft('HIRING_MANAGER');
  assert.match(manager.message, /Led a 12-bed intensive care unit across rotating shifts\. I'd value connecting\.$/);
  assert.equal(manager.claimId, 'C-01');

  for (const persona of ['RECRUITER', 'HIRING_MANAGER', 'PEER']) {
    const d = draft(persona);
    assert.ok(d.charCount <= 300);
    assert.doesNotMatch(d.message, /distributed|cloud|platform engineer|engineering|architecture/i);
  }
  // Nothing known about notice: say nothing, rather than claim immediate availability.
  const unknown = OutreachGenerator.generateOutreach({ persona: 'RECRUITER', jobRecord, dossier: {} });
  assert.doesNotMatch(unknown.message, /immediate|availability/i);
});

test('multi-vacancy triage matches the dossier target titles and skills in any profession', () => {
  const dossier = nurse();
  const plan = MultiVacancyStrategist.evaluateCompanyVacancies('Acme Health', [
    { id: 'v1', title: 'Head Nurse', level: 'Senior', department: 'Nursing' },
    { id: 'v2', title: 'ICU Nurse Manager', level: 'Lead', department: 'Critical Care' },
    { id: 'v3', title: 'Backend Developer', level: 'Senior', department: 'Software Engineering' },
    { id: 'v4', title: 'Junior Staff Nurse', level: 'Junior', department: 'Nursing' }
  ], { dossier });
  assert.deepEqual(plan.recommendations.map(r => r.action), ['APPLY', 'APPLY', 'SKIP', 'APPLY']);
  assert.match(plan.recommendations[2].reason, /No overlap/);
  assert.equal(plan.convergentCv.convergentHeadline, 'Charge Nurse');
  assert.deepEqual(plan.convergentCv.coreClaimIds, ['C-01'], 'verified dossier claims only');
  assert.doesNotMatch(JSON.stringify(plan), /Architect|Distributed|Technical|platform/i);

  // Without a dossier nothing is invented: no placeholder claim ids, no software headline.
  const blind = MultiVacancyStrategist.evaluateCompanyVacancies('Acme', [{ id: 'a', title: 'Accountant', department: 'Finance' }], {});
  assert.equal(blind.recommendations[0].action, 'APPLY');
  assert.deepEqual(blind.convergentCv.coreClaimIds, []);
  assert.equal(blind.convergentCv.convergentHeadline, 'Accountant');
});
