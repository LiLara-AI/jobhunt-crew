'use strict';

/**
 * JobHunt Crew â€” Lever ATS Adapter
 *
 * Scrapes public board JSON endpoint:
 * GET https://api.lever.co/v0/postings/{site}?mode=json&limit={limit}&skip={skip}
 *
 * @module lib/discovery/ats/lever
 */

const { BaseAtsAdapter, safeIsoDate } = require('./base-adapter');
const { normalizeJobUrl } = require('../../guardrails/dedup');

class LeverAdapter extends BaseAtsAdapter {
  constructor(options = {}) {
    super('lever', options);
    this.defaultBaseUrl = 'https://api.lever.co';
  }

  /**
   * Parses Lever raw postings into normalized jobs.
   */
  static parseJobs(postings, site = 'company', options = {}) {
    const list = Array.isArray(postings) ? postings : [];
    const company = options.company || site;

    return list
      .filter(p => p && typeof p === 'object')
      .map(p => {
      const postId = String(p.id);
      const reqId = p.requisitionCode || postId;
      const categories = p.categories || {};
      const location = categories.location || (Array.isArray(categories.allLocations) ? categories.allLocations.join(', ') : '');
      const dept = categories.department || categories.team || null;

      let compensation = null;
      if (p.salaryDescription) {
        compensation = p.salaryDescription;
      } else if (p.salaryRange) {
        const { min, max, currency, interval } = p.salaryRange;
        compensation = `${min} - ${max} ${currency || ''}${interval ? ' (' + interval + ')' : ''}`.trim();
      }

      let remoteStatus = 'unknown';
      if (p.workplaceType) {
        remoteStatus = p.workplaceType.toLowerCase();
      } else if (/remote/i.test(location + ' ' + (p.text || ''))) {
        remoteStatus = 'remote';
      } else if (/hybrid/i.test(location)) {
        remoteStatus = 'hybrid';
      } else if (location) {
        remoteStatus = 'onsite';
      }

      const rawUrl = p.hostedUrl || `https://jobs.lever.co/${site}/${postId}`;
      const cleanUrl = normalizeJobUrl(rawUrl);

      return {
        id: `lever-${site}-${postId}`,
        requisitionId: String(reqId),
        title: String(p.text || ''),
        company,
        url: cleanUrl,
        location,
        remoteStatus,
        department: dept,
        compensation,
        postedAt: safeIsoDate(p.createdAt),
        rawPayload: p,
        source: 'lever'
      };
    });
  }

  /**
   * Fetches all active postings for a Lever site.
   */
  async fetchBoard(site, options = {}) {
    const base = this.baseUrl || this.defaultBaseUrl;
    const limit = options.limit || 50;

    const allNormalized = await this.paginate(async ({ offset }) => {
      const url = `${base}/v0/postings/${encodeURIComponent(site)}?mode=json&limit=${limit}&skip=${offset}`;
      const res = await this.fetchWithRetry(url, options);

      if (!res.success || !Array.isArray(res.data)) {
        return { items: [], hasMore: false };
      }

      const jobs = LeverAdapter.parseJobs(res.data, site, options);
      const hasMore = res.data.length >= limit;

      return {
        items: jobs,
        hasMore,
        nextOffset: offset + res.data.length
      };
    }, options);

    return allNormalized;
  }
}

module.exports = {
  LeverAdapter
};
