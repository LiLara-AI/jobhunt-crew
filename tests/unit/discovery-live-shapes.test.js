'use strict';

// Adapters were written against invented fixtures; these pin the response
// shapes the real ATS APIs return, and that an unreachable board is an error
// rather than "0 jobs".

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { fetchAtsBoard } = require('../../lib/discovery/ats');
const { AshbyAdapter } = require('../../lib/discovery/ats/ashby');
const { OracleCloudAdapter } = require('../../lib/discovery/ats/oracle-cloud');
const { WorkableAdapter } = require('../../lib/discovery/ats/workable');
const { WorkdayAdapter } = require('../../lib/discovery/ats/workday');
const { getDefaultSweepTargets } = require('../../lib/cli/commands/discover');

function serve(handler) {
  return new Promise(resolve => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` }));
  });
}

test('ashby: live { jobs: [...] } shape, unlisted postings dropped', () => {
  const jobs = AshbyAdapter.parseJobs({
    apiVersion: '1',
    jobs: [
      { id: 'a1', title: 'Senior Data Scientist', location: 'Riyadh, Saudi Arabia', department: 'Data', isListed: true, jobUrl: 'https://jobs.ashbyhq.com/LeanTech/a1', publishedAt: '2026-11-19T11:12:21.308Z' },
      { id: 'a2', title: 'Hidden', location: 'Riyadh', isListed: false }
    ]
  }, 'leantech');
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].location, 'Riyadh, Saudi Arabia');
  assert.equal(jobs[0].department, 'Data');
});

test('oracle: requisitionList shape and case-preserving job URL', () => {
  const jobs = OracleCloudAdapter.parseJobs({
    items: [{ TotalJobsCount: 1, requisitionList: [{ Id: '32', Title: 'Industrial AI Architect', PrimaryLocation: 'Al Khobar, Saudi Arabia', PostedDate: '2026-11-19' }] }]
  }, 'aramcodigital', { host: 'x.fa.ocs.oraclecloud.com', site: 'CX_3001' });
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].title, 'Industrial AI Architect');
  // Lowercasing this path returns HTTP 404 on real Oracle career sites.
  assert.equal(jobs[0].url, 'https://x.fa.ocs.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_3001/job/32');
});

test('workable: widget shape gives a real location, not a publish state', () => {
  const jobs = WorkableAdapter.parseJobs({
    jobs: [{ title: 'Accountant-ERP', shortcode: 'FB74E1BE9C', city: 'Riyadh', state: 'Riyadh Province', country: 'Saudi Arabia', url: 'https://apply.workable.com/j/FB74E1BE9C', published_on: '2026-11-09', telecommuting: false }]
  }, 'foodics');
  assert.equal(jobs[0].location, 'Riyadh, Riyadh Province, Saudi Arabia');
  assert.equal(jobs[0].postedAt, '2026-11-09T00:00:00.000Z');
});

test('workday: job URL carries the career-site segment', () => {
  const jobs = WorkdayAdapter.parseJobs(
    { jobPostings: [{ title: 'Engineer', externalPath: '/job/Riyadh/Engineer_R1', locationsText: 'Riyadh' }] },
    'acme', { host: 'acme.wd3.myworkdayjobs.com', site: 'Careers' }
  );
  assert.equal(jobs[0].url, 'https://acme.wd3.myworkdayjobs.com/careers/job/riyadh/engineer_r1');
});

test('an unreachable board throws instead of returning zero jobs', async () => {
  const { server, baseUrl } = await serve((req, res) => { res.statusCode = 404; res.end('{"error":"not found"}'); });
  try {
    await assert.rejects(
      fetchAtsBoard('greenhouse', 'no-such-board', { baseUrl, maxRetries: 0 }),
      /could not be read \(HTTP 404\)/
    );
  } finally { server.close(); }
});

test('a reachable but empty board is still just zero jobs', async () => {
  const { server, baseUrl } = await serve((req, res) => { res.setHeader('content-type', 'application/json'); res.end('{"jobs":[]}'); });
  try {
    assert.deepEqual(await fetchAtsBoard('greenhouse', 'empty-board', { baseUrl, maxRetries: 0 }), []);
  } finally { server.close(); }
});

test('watchlist entries with a verified target object become sweep targets', () => {
  const targets = getDefaultSweepTargets([
    { id: 'wd', name: 'Workday Co', provider: 'workday', target: { tenant: 'acme', dc: 'wd3', site: 'Careers' }, enabled: true },
    { id: 'or', name: 'Oracle Co', provider: 'oraclecloud', target: { host: 'x.fa.ocs.oraclecloud.com', site: 'CX_1' }, enabled: true },
    { id: 'mn', name: 'Manual Co', provider: 'manual', careersUrl: 'https://example.com/careers', enabled: true }
  ]);
  assert.deepEqual(targets.map(t => `${t.provider}:${t.slug}`), ['workday:acme', 'oraclecloud:x.fa.ocs.oraclecloud.com']);
  assert.equal(targets[0].target.site, 'Careers');
});

test('bayt and naukrigulf search URLs use hyphenated slugs', () => {
  const { BrowserSweeps } = require('../../lib/discovery/browser-sweeps');
  assert.equal(
    BrowserSweeps.buildSearchUrl('bayt', 'Customer Experience Manager', 'Riyadh, Saudi Arabia'),
    'https://www.bayt.com/en/saudi-arabia/jobs/customer-experience-manager-jobs-in-riyadh/'
  );
  assert.equal(
    BrowserSweeps.buildSearchUrl('naukrigulf', 'Customer Experience Manager'),
    'https://www.naukrigulf.com/customer-experience-manager-jobs-in-saudi-arabia'
  );
});
