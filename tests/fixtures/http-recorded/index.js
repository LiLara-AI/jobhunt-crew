'use strict';
const fs = require('fs');
const path = require('path');

function loadJson(relPath) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, relPath), 'utf8'));
}

const fixtures = {
  greenhouse: {
    page1: loadJson('greenhouse/page1.json'),
    page2: loadJson('greenhouse/page2.json')
  },
  lever: {
    postings: loadJson('lever/postings.json')
  },
  ashby: {
    jobBoard: loadJson('ashby/job-board.json')
  },
  workday: {
    page1: loadJson('workday/page1.json'),
    page2: loadJson('workday/page2.json')
  },
  smartrecruiters: {
    page1: loadJson('smartrecruiters/page1.json'),
    page2: loadJson('smartrecruiters/page2.json')
  },
  oracle: {
    page1: loadJson('oracle-cloud/page1.json'),
    page2: loadJson('oracle-cloud/page2.json')
  },
  oracleCloud: {
    page1: loadJson('oracle-cloud/page1.json'),
    page2: loadJson('oracle-cloud/page2.json')
  },
  rateLimit: {
    retryAfter429: loadJson('rate-limit/retry-after-429.json')
  }
};

/**
 * Configure mock HTTP server with standard ATS routes
 */
function setupMockAtsRoutes(mockServer, state = {}) {
  // Greenhouse: boards-api.greenhouse.io/v1/boards/techcorp/jobs?content=true&page=1
  mockServer.register('GET', '/v1/boards/techcorp/jobs', (req, res, url) => {
    const page = url.searchParams.get('page') || '1';
    if (page === '2') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(fixtures.greenhouse.page2));
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(fixtures.greenhouse.page1));
    }
  });

  // Lever: api.lever.co/v0/postings/apexcloud?mode=json
  mockServer.register('GET', '/v0/postings/apexcloud', (req, res, url) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(fixtures.lever.postings));
  });

  // Ashby: api.ashbyhq.com/posting-api/job-board/novasystems
  mockServer.register('GET', '/posting-api/job-board/novasystems', (req, res, url) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(fixtures.ashby.jobBoard));
  });

  // Workday: POST /wday/cxs/tenant/site/jobs
  mockServer.register('POST', '/wday/cxs/tenant/site/jobs', (req, res, url) => {
    let offset = 0;
    try {
      const parsedBody = JSON.parse(req.body || '{}');
      offset = parsedBody.offset || 0;
    } catch (_) {}

    if (offset >= 20) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(fixtures.workday.page2));
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(fixtures.workday.page1));
    }
  });

  // SmartRecruiters: GET /v1/companies/techcorp/postings
  mockServer.register('GET', '/v1/companies/techcorp/postings', (req, res, url) => {
    const offset = Number(url.searchParams.get('offset') || '0');
    if (offset >= 10) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(fixtures.smartrecruiters.page2));
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(fixtures.smartrecruiters.page1));
    }
  });

  // Oracle Cloud HCM: GET /hcmRestApi/resources/latest/recruitingCEJobRequisitions
  mockServer.register('GET', '/hcmRestApi/resources/latest/recruitingCEJobRequisitions', (req, res, url) => {
    const offset = Number(url.searchParams.get('offset') || '0');
    if (offset >= 25) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(fixtures.oracleCloud.page2));
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(fixtures.oracleCloud.page1));
    }
  });

  // Rate-limiting test endpoint: 429 on first hit, 200 on retry
  let attemptCount = 0;
  mockServer.register('GET', '/rate-limited-endpoint', (req, res, url) => {
    attemptCount++;
    if (attemptCount === 1) {
      res.writeHead(429, {
        'Content-Type': 'application/json',
        'Retry-After': '1'
      });
      res.end(JSON.stringify(fixtures.rateLimit.retryAfter429));
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', attempt: attemptCount }));
    }
  });
}

module.exports = {
  fixtures,
  setupMockAtsRoutes
};
