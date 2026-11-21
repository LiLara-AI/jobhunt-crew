'use strict';

/**
 * JobHunt Crew — Base ATS Adapter
 *
 * Provides shared HTTP transport, canonical URL normalization,
 * remote status classification, pagination guards, and 12-field normalized schema.
 *
 * @module lib/discovery/ats/base-adapter
 */

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { normalizeJobUrl } = require('../../guardrails/dedup');
const { executeWithRetry, DomainTokenBucketRateLimiter } = require('../rate-limiter');

const defaultRateLimiter = new DomainTokenBucketRateLimiter();

class BaseAtsAdapter {
  /** Malformed dates -> null (never RangeError from toISOString). */
  static safeIsoDate(value) {
    if (value === null || value === undefined || value === '') return null;
    const d = value instanceof Date ? value : new Date(value);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }

  constructor(source, options = {}) {
    this.source = source;
    this.baseUrl = options.baseUrl || null;
    this.rateLimiter = options.rateLimiter || defaultRateLimiter;
    this.timeoutMs = options.timeoutMs || 10000;
  }

  /**
   * Performs an HTTP/HTTPS GET or POST request.
   */
  async request(targetUrl, requestOptions = {}) {
    const parsedUrl = new URL(targetUrl);
    const isHttps = parsedUrl.protocol === 'https:';
    const client = isHttps ? https : http;

    const method = requestOptions.method || 'GET';
    const headers = {
      'User-Agent': 'JobHuntCrew/0.1.0 (Job Discovery Engine)',
      'Accept': 'application/json, text/plain, */*',
      ...(requestOptions.headers || {})
    };

    let bodyData = null;
    if (requestOptions.body) {
      if (typeof requestOptions.body === 'object' && !Buffer.isBuffer(requestOptions.body)) {
        bodyData = JSON.stringify(requestOptions.body);
        headers['Content-Type'] = headers['Content-Type'] || 'application/json';
        headers['Content-Length'] = Buffer.byteLength(bodyData);
      } else {
        bodyData = requestOptions.body;
      }
    }

    // Token bucket rate limiting
    if (this.rateLimiter && typeof this.rateLimiter.acquire === 'function') {
      await this.rateLimiter.acquire(parsedUrl.hostname);
    }

    return new Promise((resolve, reject) => {
      const req = client.request(parsedUrl, {
        method,
        headers,
        timeout: this.timeoutMs
      }, res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => {
          const rawText = Buffer.concat(chunks).toString('utf8');
          let parsedData = rawText;
          try {
            parsedData = JSON.parse(rawText);
          } catch (_) {}

          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            data: parsedData,
            rawText
          });
        });
      });

      req.on('error', err => reject(err));
      req.on('timeout', () => {
        req.destroy();
        reject(new Error(`HTTP request timed out after ${this.timeoutMs}ms: ${targetUrl}`));
      });

      if (bodyData) {
        req.write(bodyData);
      }
      req.end();
    });
  }

  /**
   * Executes request with rate limiter and exponential backoff.
   */
  async fetchWithRetry(url, options = {}) {
    const domain = new URL(url).hostname;
    const res = await executeWithRetry(
      async () => this.request(url, options),
      {
        domain,
        source: this.source,
        maxRetries: options.maxRetries !== undefined ? options.maxRetries : 3,
        testMode: options.testMode || Boolean(this.baseUrl)
      }
    );
    if (res && res.success === false) {
      this.lastFailure = { url, statusCode: res.statusCode || null, error: res.error || res.message || 'request failed' };
    }
    return res;
  }

  /**
   * Classifies remote arrangement from title, location, or explicit flag.
   *
   * @param {string} text - Title or location string
   * @param {boolean} [explicitRemote=false] - Provider remote boolean flag
   * @returns {'remote' | 'hybrid' | 'onsite' | 'unknown'}
   */
  classifyRemoteStatus(text, explicitRemote = false) {
    if (explicitRemote === true) return 'remote';
    const str = String(text || '').toLowerCase();
    if (/(\bremote\b|work from home|telecommute|عن بعد)/i.test(str)) {
      return 'remote';
    }
    if (/(\bhybrid\b|هجين)/i.test(str)) {
      return 'hybrid';
    }
    if (/(\bonsite\b|on-site|حضوري)/i.test(str)) {
      return 'onsite';
    }
    if (str.trim().length > 0) {
      return 'onsite';
    }
    return 'unknown';
  }

  /**
   * Invariant 12-field normalized schema builder.
   *
   * @param {object} params
   * @returns {object} NormalizedJob
   */
  normalizeJob(params) {
    const rawUrl = params.url || '';
    const cleanUrl = normalizeJobUrl(rawUrl);
    const source = this.source || params.source || 'ats';
    const slug = (params.slug || params.company || 'co').toLowerCase().replace(/[^a-z0-9_-]/g, '');
    const requisitionId = String(params.requisitionId || params.id || '').trim();
    const id = params.customId || `${source}-${slug}-${requisitionId}`;

    return {
      id,
      requisitionId,
      title: String(params.title || '').trim(),
      company: String(params.company || params.slug || '').trim(),
      url: cleanUrl,
      location: String(params.location || '').trim(),
      remoteStatus: params.remoteStatus || this.classifyRemoteStatus(params.location + ' ' + params.title, params.isRemote),
      department: params.department !== undefined ? params.department : null,
      compensation: params.compensation !== undefined ? params.compensation : null,
      postedAt: BaseAtsAdapter.safeIsoDate(params.postedAt),
      rawPayload: params.rawPayload && typeof params.rawPayload === 'object' ? params.rawPayload : {},
      source
    };
  }

  /**
   * Generic multi-strategy pagination controller.
   *
   * @param {Function} fetchPageFn - async ({ page, offset, cursor }) => { items, hasMore, nextOffset, nextCursor }
   * @param {object} [options] - Pagination options { maxPages = 50 }
   * @returns {Promise<Array<object>>} Aggregated items across all pages
   */
  async paginate(fetchPageFn, options = {}) {
    const maxPages = options.maxPages || 50;
    const allItems = [];
    let page = 1;
    let offset = 0;
    let cursor = null;
    const seenSignatures = new Set();

    for (let iteration = 0; iteration < maxPages; iteration++) {
      const pageResult = await fetchPageFn({ page, offset, cursor });
      if (!pageResult || !Array.isArray(pageResult.items) || pageResult.items.length === 0) {
        break;
      }

      // Cycle detection guard
      const signature = crypto.createHash('sha256').update(JSON.stringify(pageResult.items)).digest('hex');
      if (seenSignatures.has(signature)) {
        break;
      }
      seenSignatures.add(signature);

      allItems.push(...pageResult.items);

      if (pageResult.hasMore === false) {
        break;
      }

      // Advance pointers
      page++;
      offset = pageResult.nextOffset !== undefined ? pageResult.nextOffset : (offset + pageResult.items.length);
      cursor = pageResult.nextCursor || null;
    }

    return allItems;
  }
}

function safeIsoDate(value) {
  return BaseAtsAdapter.safeIsoDate(value);
}

module.exports = {
  BaseAtsAdapter,
  safeIsoDate
};
