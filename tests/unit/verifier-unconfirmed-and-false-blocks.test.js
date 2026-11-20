'use strict';

// ClaimVerifier: unconfirmed claims are gated (UNVERIFIED_CLAIM), and truthful
// GCC documents are not false-blocked — without opening any false pass.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ClaimVerifier } = require('../../lib/honest-cv/verify-claims');
const example = require('../../templates/CareerDossier.example.json');

const clone = (o) => JSON.parse(JSON.stringify(o));
const codes = (result) => result.violations.map(v => v.code);
const verify = (text, options, dossier = example) => ClaimVerifier.verifyDraft(dossier, text, options);

function assertClean(text, options) {
  const result = verify(text, options);
  assert.deepEqual(result.violations.map(v => `${v.code}: ${v.details}`), [], text);
}

function assertBlocked(text, code, options, dossier) {
  const result = verify(text, options, dossier);
  assert.equal(result.passed, false, text);
  assert.ok(codes(result).includes(code), `${text} -> expected ${code}, got ${codes(result).join(', ') || 'none'}`);
}

test('a draft built on unconfirmed claims is blocked with UNVERIFIED_CLAIM', () => {
  const unconfirmed = clone(example);
  unconfirmed.claims.forEach(c => { c.status = 'CONFIRM'; });

  // Verbatim claim text, with and without its figures.
  assertBlocked(unconfirmed.claims[0].text, 'UNVERIFIED_CLAIM', {}, unconfirmed);
  assertBlocked('Mentored junior and mid-level engineers, establishing engineering quality standards.', 'UNVERIFIED_CLAIM', {}, unconfirmed);
  // Cited by id: via options (reported once for the draft) or by tag in the text.
  const cited = verify('Seasoned engineer.\nReliable colleague.', { claimIds: ['C-01'] }, unconfirmed);
  assert.deepEqual(cited.violations.map(v => [v.code, v.claimId]), [['UNVERIFIED_CLAIM', 'C-01']]);
  assertBlocked('Optimised autoscaling [C-03].', 'UNVERIFIED_CLAIM', {}, unconfirmed);
  // Any status other than VERIFIED is unconfirmed.
  const pending = clone(example);
  pending.claims[2].status = 'pending';
  assertBlocked('Reduced cloud infrastructure expenditures by 28%.', 'UNVERIFIED_CLAIM', {}, pending);
});

test('confirmed claims still pass while another claim awaits confirmation', () => {
  const mixed = clone(example);
  mixed.claims[2].status = 'CONFIRM';
  const result = verify(`${mixed.claims[0].text}\n${mixed.claims[1].text}`, {}, mixed);
  assert.deepEqual(result.violations, []);
  // Legacy dossiers without a status field keep working.
  const legacy = clone(example);
  legacy.claims.forEach(c => { delete c.status; });
  assert.equal(verify(legacy.claims[0].text, {}, legacy).passed, true);
});

test('the candidate\'s own contact details are not metrics', () => {
  assertClean('Alex Rivera\nalex.rivera@example.org | +966 55 111 2222 | Riyadh, Saudi Arabia');
  assertClean('Mobile: +966-55-111-2222');
  // Someone else's number, or a longer number that merely starts with it, is still checked.
  assertBlocked('Call +966 55 111 3333.', 'METRIC_INFLATION');
  assertBlocked('Processed +966 55 111 22229 requests.', 'METRIC_INFLATION');
});

test('"Vision 2030" is a programme name, in English and Arabic', () => {
  assertClean('I am motivated by the goals of Saudi Vision 2030.');
  assertClean('أدعم أهداف رؤية 2030.');
  assertBlocked('I support Vision 2040.', 'METRIC_INFLATION');
  assertBlocked('Delivered 2030 projects.', 'METRIC_INFLATION');
});

test('GCC countries and cities are places, not employers', () => {
  assertClean('I am based at Abu Dhabi. I am located at Dhahran. I spent time on site at Doha.');
  assertClean('Available for roles at Muscat, at Manama and at Jubail.');
  assertBlocked('I worked at Globex Corporation.', 'UNKNOWN_EMPLOYER');
  assertBlocked('I worked at Doha Dynamics.', 'UNKNOWN_EMPLOYER');
  // Sentence-initial "At <Org>" is an employer mention too.
  assertBlocked('At Globex, I designed the ranking system.', 'UNKNOWN_EMPLOYER');
  assertBlocked('At NEOM, I mentored 6 engineers.', 'UNKNOWN_EMPLOYER');
});

test('the target company is known where the draft applies to it, never as an employer', () => {
  const options = { targetCompany: 'Tamara' };
  assertClean('I am applying for the Staff Engineer role at Tamara.', options);
  assertClean('Having mentored 6 engineers at Apex Cloud Technologies, I am excited to apply for the Staff Engineer role at Tamara.', options);
  // Not supplied by the caller: still unknown.
  assertBlocked('I am applying for the Staff Engineer role at Tamara.', 'UNKNOWN_EMPLOYER');
  // Supplied, but claimed as employment: still unknown.
  for (const text of [
    'Staff Engineer at Tamara.',
    'While at Tamara, I mentored 6 engineers.',
    'I worked at Tamara.',
    'After applying lessons learned at Tamara.',
    'My application follows a long tenure at Tamara.'
  ]) assertBlocked(text, 'UNKNOWN_EMPLOYER', options);
  // A different company is not covered by the exemption.
  assertBlocked('I am applying for the Staff Engineer role at Globex.', 'UNKNOWN_EMPLOYER', options);
});

test('NEOM is accepted as a destination or location, not as an invented employer', () => {
  assertClean('I am applying for the Director role at NEOM.');
  assertClean('I am based at NEOM.');
  for (const text of ['Senior Director at NEOM.', 'While at NEOM, I mentored 6 engineers.', 'Keen operator with 5 years at NEOM.']) {
    assertBlocked(text, 'UNKNOWN_EMPLOYER');
  }
});
