'use strict';
/**
 * Tier 1: Feature Coverage - Multi-Channel Discovery Adapters & Offline HTTP Fixtures
 * Verifies Greenhouse, Lever, Ashby, Workday, SmartRecruiters, and Oracle Cloud HCM
 * adapters against recorded responses using real production modules.
 */

const { TestSuite, MockHttpServer } = require('../helpers/test-harness');
const { fixtures, setupMockAtsRoutes } = require('../fixtures/http-recorded/index');
const {
  AtsParser,
  fetchAtsBoard,
  GreenhouseAdapter,
  LeverAdapter,
  AshbyAdapter,
  WorkdayAdapter,
  SmartRecruitersAdapter,
  OracleCloudAdapter
} = require('../../lib/discovery/ats');
const { KsaCountryPack, evaluateKsaCompliance } = require('../../lib/discovery/ksa-pack');

const suite = new TestSuite('Tier 1: Multi-Channel Discovery Adapters');

let mockServer;
let baseUrl;

suite.test('Set up offline mock HTTP server with recorded ATS routes', async assert => {
  mockServer = new MockHttpServer();
  setupMockAtsRoutes(mockServer);
  await mockServer.start();
  baseUrl = mockServer.getBaseUrl();
  assert.ok(baseUrl.startsWith('http://127.0.0.1:'));
});

suite.test('Greenhouse adapter parses multi-page fixtures completely', async assert => {
  const p1 = AtsParser.parseGreenhouse(fixtures.greenhouse.page1);
  const p2 = AtsParser.parseGreenhouse(fixtures.greenhouse.page2);

  assert.equal(p1.length, 2);
  assert.equal(p1[0].title, 'Staff Platform Engineer');
  assert.equal(p2.length, 1);
  assert.equal(p2[0].title, 'Senior Reliability Engineer (SRE)');

  // Verify pagination total
  const all = [...p1, ...p2];
  assert.equal(all.length, 3);
  assert.equal(p1[0].url.includes('gh_jid'), false, 'Greenhouse tracking parameter gh_jid is stripped');
  assert.equal(p1[0].url, 'https://boards.greenhouse.io/techcorp/jobs/50101');

  // Verify full pagination via adapter against mock server
  const ghJobs = await fetchAtsBoard('greenhouse', 'techcorp', { baseUrl });
  assert.equal(ghJobs.length, 3);
  assert.equal(ghJobs[0].source, 'greenhouse');
  assert.equal(ghJobs[0].url.includes('gh_jid'), false, 'Greenhouse fetched job URL strips tracking parameter');
});

suite.test('Lever, Ashby, Workday, and SmartRecruiters parse recorded responses cleanly', async assert => {
  const leverJobs = AtsParser.parseLever(fixtures.lever.postings);
  assert.equal(leverJobs.length, 2);
  assert.equal(leverJobs[0].title, 'Lead Platform Engineer');

  const ashbyJobs = AtsParser.parseAshby(fixtures.ashby.jobBoard);
  assert.equal(ashbyJobs.length, 1);
  assert.equal(ashbyJobs[0].title, 'Principal Architect - Infrastructure');
  assert.ok(ashbyJobs[0].compensation.includes('45,000'));

  const workdayJobsP1 = AtsParser.parseWorkday(fixtures.workday.page1);
  assert.equal(workdayJobsP1.length, 2);
  assert.ok(workdayJobsP1[0].url.includes('jr-1001') || workdayJobsP1[0].url.includes('JR-1001'));

  const srJobs = AtsParser.parseSmartRecruiters(fixtures.smartrecruiters.page1);
  assert.equal(srJobs.length, 1);
  assert.equal(srJobs[0].title, 'Senior Cloud Infrastructure Architect');

  // Verify Workday multi-page pagination against mock server
  const wdAll = await fetchAtsBoard('workday', { tenant: 'tenant', site: 'site' }, { baseUrl });
  assert.equal(wdAll.length, 3);

  // Verify SmartRecruiters multi-page pagination against mock server
  const srAll = await fetchAtsBoard('smartrecruiters', 'techcorp', { baseUrl });
  assert.equal(srAll.length, 2);
});

suite.test('Oracle Cloud HCM adapter parses recorded fixtures and paginates', async assert => {
  const p1 = AtsParser.parseOracleCloud(fixtures.oracle.page1);
  const p2 = AtsParser.parseOracleCloud(fixtures.oracle.page2);

  assert.equal(p1.length, 1);
  assert.equal(p1[0].title, 'Principal Infrastructure Architect - Cloud Services');
  assert.equal(p1[0].remoteStatus, 'hybrid');
  assert.equal(p1[0].source, 'oracle');
  assert.equal(p1[0].url.includes('utm_source'), false, 'Oracle Cloud tracking parameter utm_source is stripped');
  assert.equal(p1[0].url.includes('utm_campaign'), false, 'Oracle Cloud tracking parameter utm_campaign is stripped');
  assert.equal(p1[0].url, 'https://careers.neom.com/hcmui/candidateexperience/en/sites/cx/job/300000109928172');

  assert.equal(p2.length, 1);
  assert.equal(p2[0].title, 'Senior Reliability Engineer - Critical Fabrics');
  assert.equal(p2[0].remoteStatus, 'onsite');

  // Verify pagination against mock server
  const oracleAll = await fetchAtsBoard('oracle', 'neom', { baseUrl });
  assert.equal(oracleAll.length, 2);
  assert.equal(oracleAll[0].requisitionId, 'NEOM-2026-901');
  assert.equal(oracleAll[1].requisitionId, 'NEOM-2026-902');
  assert.equal(oracleAll[0].url.includes('utm_source'), false);
});

suite.test('All 6 ATS adapters normalize URLs and strip tracking parameters at source', assert => {
  // 1. Greenhouse with tracking query
  const gh = GreenhouseAdapter.parseJobs([
    { id: 999, absolute_url: 'https://boards.greenhouse.io/corp/jobs/999?gh_jid=999&utm_source=linkedin' }
  ], 'corp');
  assert.equal(gh[0].url, 'https://boards.greenhouse.io/corp/jobs/999', 'Greenhouse tracking params stripped');

  // 2. Lever with /apply and tracking query
  const lev = LeverAdapter.parseJobs([
    { id: 'lev-1', text: 'Architect', hostedUrl: 'https://jobs.lever.co/corp/lev-1/apply?lever-source=linkedin' }
  ], 'corp');
  assert.equal(lev[0].url, 'https://jobs.lever.co/corp/lev-1', 'Lever /apply and tracking params stripped');

  // 3. Ashby with /application and tracking query
  const ash = AshbyAdapter.parseJobs({
    jobPostings: [
      { id: 'ash-1', title: 'Engineer', jobUrl: 'https://jobs.ashbyhq.com/corp/ash-1/application?ashby_jid=ash-1&utm_source=feed' }
    ]
  }, 'corp');
  assert.equal(ash[0].url, 'https://jobs.ashbyhq.com/corp/ash-1', 'Ashby /application and tracking params stripped');

  // 4. Workday with tracking query
  const wd = WorkdayAdapter.parseJobs([
    { externalPath: '/job/R100/?utm_source=indeed' }
  ], 'tenant', { host: 'tenant.wd1.myworkdayjobs.com' });
  assert.equal(wd[0].url, 'https://tenant.wd1.myworkdayjobs.com/job/r100', 'Workday tracking params stripped');

  // 5. SmartRecruiters with tracking query
  const sr = SmartRecruitersAdapter.parseJobs({
    content: [
      { id: 'sr-1', name: 'Lead', postingUrl: 'https://jobs.smartrecruiters.com/corp/sr-1?utm_campaign=social' }
    ]
  }, 'corp');
  assert.equal(sr[0].url, 'https://jobs.smartrecruiters.com/corp/sr-1', 'SmartRecruiters tracking params stripped');

  // 6. Oracle Cloud HCM with utm parameters
  const ora = OracleCloudAdapter.parseJobs([
    { Id: '777', ExternalURL: 'https://careers.corp.com/hcmUI/CandidateExperience/en/sites/CX/job/777?utm_source=linkedin' }
  ], 'corp');
  assert.equal(ora[0].url, 'https://careers.corp.com/hcmui/candidateexperience/en/sites/cx/job/777', 'Oracle Cloud tracking params stripped');
});

suite.test('KSA Country Pack evaluates Saudization restrictions and scam flags', assert => {
  const saudiOnlyJd = 'We are hiring a Senior Director of IT. Notice: Saudi nationals only due to Saudization quotas.';
  const comp1 = evaluateKsaCompliance(saudiOnlyJd, 'Transferable Iqama');
  assert.equal(comp1.eligible, false);
  assert.equal(comp1.isSaudizationRestricted, true);

  const comp2 = evaluateKsaCompliance(saudiOnlyJd, 'Saudi National');
  assert.equal(comp2.eligible, true);
  assert.equal(comp2.isPriority, true);

  const scamJd = 'Urgent offer! Please submit your $500 visa deposit fee to secure your contract.';
  const scamComp = evaluateKsaCompliance(scamJd, 'Saudi National');
  assert.equal(scamComp.eligible, false);
  assert.equal(scamComp.isColdOfferScamRisk, true);
});

suite.test('Tear down offline mock HTTP server', async assert => {
  if (mockServer) {
    await mockServer.stop();
  }
  assert.ok(true);
});

module.exports = suite;
if (require.main === module) {
  suite.run({ verbose: true });
}
