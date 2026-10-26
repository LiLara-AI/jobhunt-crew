'use strict';
/**
 * Test Harness & Assertion Utilities for JobHunt Crew E2E Test Suite
 * Zero external dependencies: pure Node.js built-ins.
 */

const http = require('http');
const path = require('path');
const fs = require('fs');

class TestSuite {
  constructor(name) {
    this.name = name;
    this.tests = [];
    this.passed = 0;
    this.failed = 0;
    this.errors = [];
  }

  test(description, fn) {
    this.tests.push({ description, fn });
  }

  async run(options = {}) {
    const verbose = options.verbose || false;
    const results = [];
    for (const t of this.tests) {
      const start = Date.now();
      try {
        await t.fn(assert);
        const duration = Date.now() - start;
        this.passed++;
        results.push({ description: t.description, passed: true, duration });
        if (verbose) {
          console.log(`    ✓ ${t.description} (${duration}ms)`);
        }
      } catch (err) {
        const duration = Date.now() - start;
        this.failed++;
        this.errors.push({ test: t.description, error: err });
        results.push({ description: t.description, passed: false, duration, error: err });
        if (verbose) {
          console.log(`    ✗ ${t.description} (${duration}ms)`);
          console.log(`      Error: ${err.message}`);
        }
      }
    }
    return {
      name: this.name,
      total: this.tests.length,
      passed: this.passed,
      failed: this.failed,
      errors: this.errors,
      results
    };
  }
}

const assert = {
  ok(val, msg) {
    if (!val) throw new Error(msg || `Expected truthy value but got: ${val}`);
  },
  equal(actual, expected, msg) {
    if (actual !== expected) {
      throw new Error(msg || `Expected ${JSON.stringify(expected)} but got ${JSON.stringify(actual)}`);
    }
  },
  notEqual(actual, expected, msg) {
    if (actual === expected) {
      throw new Error(msg || `Expected values to differ: ${JSON.stringify(actual)}`);
    }
  },
  deepEqual(actual, expected, msg) {
    const aStr = JSON.stringify(actual);
    const eStr = JSON.stringify(expected);
    if (aStr !== eStr) {
      throw new Error(msg || `Deep equality mismatch:\nExpected: ${eStr}\nActual:   ${aStr}`);
    }
  },
  throws(fn, expectedRegexOrMessage, msg) {
    let threw = false;
    let actualErr = null;
    try {
      fn();
    } catch (err) {
      threw = true;
      actualErr = err;
    }
    if (!threw) throw new Error(msg || 'Expected function to throw an error, but it returned normally');
    if (expectedRegexOrMessage instanceof RegExp) {
      if (!expectedRegexOrMessage.test(actualErr.message)) {
        throw new Error(`Thrown error message "${actualErr.message}" does not match pattern ${expectedRegexOrMessage}`);
      }
    } else if (typeof expectedRegexOrMessage === 'string') {
      if (!actualErr.message.includes(expectedRegexOrMessage)) {
        throw new Error(`Thrown error message "${actualErr.message}" does not contain "${expectedRegexOrMessage}"`);
      }
    }
  },
  async rejects(promiseOrFn, expectedRegexOrMessage, msg) {
    let threw = false;
    let actualErr = null;
    try {
      if (typeof promiseOrFn === 'function') {
        await promiseOrFn();
      } else {
        await promiseOrFn;
      }
    } catch (err) {
      threw = true;
      actualErr = err;
    }
    if (!threw) throw new Error(msg || 'Expected promise to reject, but it resolved successfully');
    if (expectedRegexOrMessage instanceof RegExp) {
      if (!expectedRegexOrMessage.test(actualErr.message)) {
        throw new Error(`Rejected error message "${actualErr.message}" does not match pattern ${expectedRegexOrMessage}`);
      }
    } else if (typeof expectedRegexOrMessage === 'string') {
      if (!actualErr.message.includes(expectedRegexOrMessage)) {
        throw new Error(`Rejected error message "${actualErr.message}" does not contain "${expectedRegexOrMessage}"`);
      }
    }
  },
  includes(container, item, msg) {
    if (!container || !container.includes(item)) {
      throw new Error(msg || `Expected container to include ${JSON.stringify(item)}`);
    }
  },
  greaterThan(actual, threshold, msg) {
    if (actual <= threshold) {
      throw new Error(msg || `Expected ${actual} > ${threshold}`);
    }
  },
  lessThanOrEqual(actual, threshold, msg) {
    if (actual > threshold) {
      throw new Error(msg || `Expected ${actual} <= ${threshold}`);
    }
  }
};

/**
 * Lightweight local Mock HTTP Server for recorded ATS playback
 */
class MockHttpServer {
  constructor() {
    this.routes = new Map();
    this.server = null;
    this.port = 0;
    this.requestLog = [];
  }

  register(method, urlPath, handler) {
    this.routes.set(`${method.toUpperCase()} ${urlPath}`, handler);
  }

  async start() {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        const parsedUrl = new URL(req.url, `http://localhost`);
        const key = `${req.method.toUpperCase()} ${parsedUrl.pathname}`;
        this.requestLog.push({ method: req.method, url: req.url, timestamp: Date.now() });

        const handler = this.routes.get(key);
        if (handler) {
          let body = '';
          req.on('data', chunk => { body += chunk; });
          req.on('end', () => {
            req.body = body;
            handler(req, res, parsedUrl);
          });
        } else {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Not found in mock ATS server', path: parsedUrl.pathname }));
        }
      });

      this.server.listen(0, '127.0.0.1', () => {
        this.port = this.server.address().port;
        resolve(this.port);
      });
      this.server.on('error', reject);
    });
  }

  async stop() {
    if (!this.server) return;
    return new Promise(resolve => {
      this.server.close(() => {
        this.server = null;
        resolve();
      });
    });
  }

  getBaseUrl() {
    return `http://127.0.0.1:${this.port}`;
  }
}

module.exports = {
  TestSuite,
  assert,
  MockHttpServer
};
