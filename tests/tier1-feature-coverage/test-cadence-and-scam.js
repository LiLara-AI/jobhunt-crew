'use strict';

/**
 * Tier 1: Feature Coverage — Follow-Up Cadence & Scam Triage
 *
 * Verifies:
 * 1. 7-day and 14-day post-submission cadence milestones with deterministic reference dates.
 * 2. Inbound communication signal parser across all 4 recruitment categories.
 * 3. ScamSentinel multi-rule scoring and threshold classifications.
 */

const { TestSuite } = require('../helpers/test-harness');
const {
  CadenceEngine,
  InboxSignalParser,
  ScamSentinel,
  DAY_7_MS,
  DAY_14_MS
} = require('../../lib/crew/cadence');

const suite = new TestSuite('M5 Feature 29: Follow-Up Cadence Engine & Scam Triage');

suite.test('CadenceEngine computes 7-day and 14-day follow-up milestones deterministically', assert => {
  const submissionDate = '2026-10-01T00:00:00.000Z';

  // Day 4: Pending
  const day4 = CadenceEngine.calculateCadence(submissionDate, '2026-10-05T00:00:00.000Z');
  assert.equal(day4.daysSinceSubmission, 4);
  assert.equal(day4.day7Status, 'PENDING');
  assert.equal(day4.day14Status, 'PENDING');
  assert.equal(day4.nextAction, 'WAITING');
  assert.equal(day4.daysUntilDue, 3);

  // Day 7: Due
  const day7 = CadenceEngine.calculateCadence(submissionDate, '2026-10-08T00:00:00.000Z');
  assert.equal(day7.daysSinceSubmission, 7);
  assert.equal(day7.day7Status, 'DUE');
  assert.equal(day7.nextAction, 'DUE_CADENCE_7');
  assert.equal(day7.daysUntilDue, 0);

  // Day 10: If day 7 was sent, waiting for day 14
  const day10 = CadenceEngine.calculateCadence(submissionDate, '2026-10-11T00:00:00.000Z', { day7Sent: true });
  assert.equal(day10.day7Status, 'SENT');
  assert.equal(day10.day14Status, 'PENDING');
  assert.equal(day10.nextAction, 'WAITING_DAY_14');
  assert.equal(day10.daysUntilDue, 4);

  // Day 14: Due Cadence 14
  const day14 = CadenceEngine.calculateCadence(submissionDate, '2026-10-15T00:00:00.000Z', { day7Sent: true });
  assert.equal(day14.day14Status, 'DUE');
  assert.equal(day14.nextAction, 'DUE_CADENCE_14');

  // Day 20: Complete if both sent
  const day20 = CadenceEngine.calculateCadence(submissionDate, '2026-10-21T00:00:00.000Z', { day7Sent: true, day14Sent: true });
  assert.equal(day20.day7Status, 'SENT');
  assert.equal(day20.day14Status, 'SENT');
  assert.equal(day20.nextAction, 'CADENCE_COMPLETE');
});

suite.test('CadenceEngine evaluates application queues and suggests draft personas', assert => {
  const applications = [
    { id: 'app_1', company: 'Aramco', title: 'Platform Lead', submittedAt: '2026-10-01T00:00:00.000Z', status: 'submitted' },
    { id: 'app_2', company: 'NEOM', title: 'Cloud Architect', submittedAt: '2026-10-10T00:00:00.000Z', status: 'submitted' },
    { id: 'app_3', company: 'STC', title: 'DevOps Lead', status: 'drafted' } // Not submitted
  ];

  const results = CadenceEngine.evaluateApplications(applications, '2026-10-16T00:00:00.000Z');
  assert.equal(results.length, 2, 'Must evaluate only submitted applications');

  const app1 = results.find(r => r.jobId === 'app_1');
  assert.ok(app1.daysSinceSubmission >= 14);
  assert.equal(app1.suggestedDraftPersona, 'HIRING_MANAGER');
});

suite.test('InboxSignalParser correctly categorizes incoming recruitment signals', assert => {
  // 1. Interview Invitation
  const interviewMsg = {
    subject: 'Interview Invitation: Senior Platform Architect',
    body: 'We were impressed by your background and would like to invite you to interview via calendly.com/team/screen.'
  };
  const s1 = InboxSignalParser.parseSignal(interviewMsg);
  assert.equal(s1.category, 'INTERVIEW_INVITATION');
  assert.equal(s1.isInterview, true);

  // Arabic interview invitation
  const interviewAr = 'يسرنا دعوة للمقابلة الشخصية للوظيفة المعلنة';
  const s1Ar = InboxSignalParser.parseSignal(interviewAr);
  assert.equal(s1Ar.category, 'INTERVIEW_INVITATION');

  // 2. Positive Engagement
  const posMsg = 'We reviewed your application and would like to progress to the next step in our process.';
  const s2 = InboxSignalParser.parseSignal(posMsg);
  assert.equal(s2.category, 'POSITIVE_ENGAGEMENT');

  // 3. Rejection
  const rejMsg = 'Thank you for your interest. After review, we have decided to pursue other candidates at this time.';
  const s3 = InboxSignalParser.parseSignal(rejMsg);
  assert.equal(s3.category, 'REJECTION');

  // 4. Application Acknowledged
  const ackMsg = 'Thank you for applying to TechCorp. We have received your application.';
  const s4 = InboxSignalParser.parseSignal(ackMsg);
  assert.equal(s4.category, 'APPLICATION_ACKNOWLEDGED');
});

suite.test('ScamSentinel detects fraud patterns and protects candidate with risk scoring', assert => {
  // Test Case A: Cold offer without application + check cashing
  const scamA = ScamSentinel.triage({
    subject: 'Congratulations! You are appointed for Senior Manager Position',
    body: 'We are sending a cashier\'s check of $5,000 for your home office. Deposit the mobile check and wire the difference back to our vendor.',
    sender: 'careers.aramco@gmail.com'
  }, { hasMatchingApplication: false });

  assert.equal(scamA.isScam, true);
  assert.equal(scamA.riskLevel, 'CRITICAL');
  assert.ok(scamA.riskScore >= 50);
  assert.equal(scamA.recommendation, 'BLOCK_AND_REPORT');

  // Test Case B: Upfront visa processing fee
  const scamB = ScamSentinel.triage({
    subject: 'Offer Letter & Visa Endorsement',
    body: 'Please send $450 visa processing fee and security deposit to our travel desk to initiate your Iqama transfer.',
    sender: 'recruiting@neom-careers.com'
  });
  assert.equal(scamB.isScam, true);
  assert.equal(scamB.riskLevel, 'CRITICAL');

  // Test Case C: Legitimate corporate message
  const legit = ScamSentinel.triage({
    subject: 'Next steps with your Red Sea Global application',
    body: 'Our engineering director would like to schedule a 30-minute technical architecture conversation next week.',
    sender: 'talent@redseaglobal.com'
  }, { hasMatchingApplication: true });

  assert.equal(legit.isScam, false);
  assert.ok(legit.riskScore < 15);
  assert.equal(legit.recommendation, 'PROCEED');
});

module.exports = suite;
if (require.main === module) {
  suite.run({ verbose: true });
}
