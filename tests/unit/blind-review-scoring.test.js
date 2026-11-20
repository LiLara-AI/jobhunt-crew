'use strict';

// Blind review: no score floors, feedback derived from the draft, approval at 4.0.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { BlindReviewPanel } = require('../../lib/honest-cv/review-panel');
const example = require('../../templates/CareerDossier.example.json');

const JD = {
  title: 'Staff Software Engineer',
  company: 'Tamara',
  requirementsText: 'Distributed systems on AWS with TypeScript, Node.js, Kafka and Kubernetes. Mentoring engineers and owning CI/CD pipelines.'
};

// A truthful CV: every fact comes from the example dossier.
const GOOD_CV = [
  'Staff Software Engineer',
  'Summary: Full-stack engineer with 9 years of experience specializing in distributed systems, TypeScript, Node.js, and cloud architectures.',
  'Experience',
  'Staff Software Engineer, Apex Cloud Technologies',
  '- Architected event-driven microservices processing 12,000 requests per second with sub-50ms latency.',
  '- Mentored 6 junior and mid-level engineers, establishing engineering quality standards and automated CI/CD pipelines.',
  'Senior Backend Engineer, Oasis Digital Commerce',
  '- Reduced cloud infrastructure expenditures by 28% through autoscaling optimization and caching strategies.',
  'Skills: TypeScript, Node.js, Kafka, Redis, AWS, Docker, Kubernetes',
  'Education: B.Sc. Computer Science, Example University'
].join('\n');

const review = (content, jd = JD, options = {}) => BlindReviewPanel.evaluate(jd, { type: 'cv', content }, options);
const allScores = (r) => [...Object.values(r.recruiter.criteriaScores), ...Object.values(r.hiringManager.criteriaScores)];

test('an empty or off-topic draft scores at the bottom and is not approved', () => {
  for (const content of ['', '   ', 'I like turtles. The weather is nice today.']) {
    const result = review(content);
    assert.equal(result.verdict, 'REQUEST_CHANGES', JSON.stringify(content));
    assert.deepEqual(allScores(result), [1, 1, 1, 1, 1, 1], 'no criterion has a floor above 1.0');
    assert.equal(result.overallScore, 1);
    assert.deepEqual(result.recruiter.strengths, [], 'no praise for content that is not there');
    assert.deepEqual(result.hiringManager.strengths, []);
  }
});

test('feedback names what is actually missing', () => {
  const offTopic = review('I like turtles. The weather is nice today.');
  const recruiter = offTopic.recruiter.improvements.join('\n');
  assert.match(recruiter, /Job keywords not found in the draft: .*kubernetes/);
  assert.match(recruiter, /Missing CV sections: Experience, Education, Skills/);
  assert.match(offTopic.hiringManager.improvements.join('\n'), /No quantified results/);

  const good = review(GOOD_CV);
  assert.match(good.recruiter.strengths.join('\n'), /Covers \d+ of \d+ job keywords/);
  assert.match(good.hiringManager.strengths.join('\n'), /Results are quantified/);
  assert.doesNotMatch(good.recruiter.improvements.join('\n'), /Missing CV sections/);
  assert.doesNotMatch(good.hiringManager.improvements.join('\n'), /No quantified results/);
});

test('approval needs 4.0, a job description, and a relevant draft', () => {
  const good = review(GOOD_CV, JD, { dossier: example });
  assert.equal(good.verdict, 'APPROVE');
  assert.ok(good.overallScore >= 4.0, `score ${good.overallScore}`);

  // The same CV against an unrelated vacancy is off-topic.
  const unrelated = review(GOOD_CV, { title: 'Head Pastry Chef', requirementsText: 'Viennoiserie, chocolate tempering, kitchen hygiene, menu costing' });
  assert.equal(unrelated.verdict, 'REQUEST_CHANGES');
  assert.equal(unrelated.recruiter.criteriaScores.ats_keyword_density, 1);

  // No job description at all: fit cannot be judged, so nothing is approved.
  const noJd = review(GOOD_CV, {});
  assert.equal(noJd.verdict, 'REQUEST_CHANGES');
  assert.match(noJd.recruiter.improvements.join('\n'), /No job requirements were supplied/);

  // 3.5 used to pass; the documented bar is 4.0. Two bullets against the full JD land in
  // between, with both personas above their 3.0 minimum, so only the 4.0 bar holds them back.
  const thin = review(GOOD_CV.split('\n').slice(3, 6).join('\n'));
  assert.ok(thin.overallScore >= 3.5 && thin.overallScore < 4.0, `score ${thin.overallScore}`);
  assert.ok(thin.recruiter.score >= 3.0 && thin.hiringManager.score >= 3.0);
  assert.equal(thin.verdict, 'REQUEST_CHANGES');
});

test('fast lane uses the same gate and reports real recommendations', () => {
  const blank = BlindReviewPanel.evaluate(JD, { type: 'cv', content: '' }, { mode: 'fast_lane' });
  assert.equal(blank.verdict, 'REQUEST_CHANGES');
  assert.equal(blank.overallScore, 1);
  assert.equal(blank.topRecommendations[0], 'The draft is empty');
});
