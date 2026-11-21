'use strict';

/**
 * JobHunt Crew â€” Ashby ATS Adapter
 *
 * Scrapes public job-board API endpoint:
 * GET https://api.ashbyhq.com/posting-api/job-board/{organization}
 *
 * @module lib/discovery/ats/ashby
 */

const { BaseAtsAdapter, safeIsoDate } = require('./base-adapter');
const { normalizeJobUrl } = require('../../guardrails/dedup');

class AshbyAdapter extends BaseAtsAdapter {
  constructor(options = {}) {
    super('ashby', options);
    this.defaultBaseUrl = 'https://api.ashbyhq.com';
  }

  /**
   * Parses Ashby raw response into normalized jobs.
   */
  static parseJobs(data, organization = 'company', options = {}) {
    let postings = [];
    let boardName = organization;

    if (data && typeof data === 'object') {
      if (data.jobBoard) {
        boardName = data.jobBoard.name || organization;
        postings = Array.isArray(data.jobBoard.jobPostings) ? data.jobBoard.jobPostings : [];
      } else if (Array.isArray(data.jobPostings)) {
        postings = data.jobPostings;
      } else if (Array.isArray(data.jobs)) {
        // Live posting-api shape: { jobs: [{ location, department, isListed }] }
        postings = data.jobs.filter(p => !p || p.isListed !== false);
      } else if (Array.isArray(data)) {
        postings = data;
      }
    }

    const company = options.company || boardName;

    return postings
      .filter(p => p && typeof p === 'object')
      .map(p => {
      const postId = String(p.id);
      const reqId = p.externalId || postId;
      const location = p.locationName || (typeof p.location === 'string' ? p.location : '') || '';
      const dept = p.departmentName || p.department || null;
      const compensation = p.compensation ? (p.compensation.compensationTierSummary || null) : null;

      let remoteStatus = 'unknown';
      if (p.isRemote === true) {
        remoteStatus = 'remote';
      } else if (/hybrid/i.test(location + ' ' + (p.title || ''))) {
        remoteStatus = 'hybrid';
      } else if (location) {
        remoteStatus = 'onsite';
      }

      const rawUrl = p.jobUrl || `https://jobs.ashbyhq.com/${organization}/${postId}`;
      const cleanUrl = normalizeJobUrl(rawUrl);

      return {
        id: `ashby-${organization}-${postId}`,
        requisitionId: String(reqId),
        title: String(p.title || ''),
        company,
        url: cleanUrl,
        location,
        remoteStatus,
        department: dept,
        compensation,
        postedAt: safeIsoDate(p.publishedAt),
        rawPayload: p,
        source: 'ashby'
      };
    });
  }

  /**
   * Fetches all active postings for an Ashby organization.
   */
  async fetchBoard(organization, options = {}) {
    const base = this.baseUrl || this.defaultBaseUrl;

    const allNormalized = await this.paginate(async ({ cursor }) => {
      let url = `${base}/posting-api/job-board/${encodeURIComponent(organization)}`;
      if (cursor) {
        url += `?cursor=${encodeURIComponent(cursor)}`;
      }

      const res = await this.fetchWithRetry(url, options);
      if (!res.success || !res.data) {
        return { items: [], hasMore: false };
      }

      const jobs = AshbyAdapter.parseJobs(res.data, organization, options);
      const nextCursor = res.data.nextCursor || res.data.cursor || null;

      return {
        items: jobs,
        hasMore: Boolean(nextCursor),
        nextCursor
      };
    }, options);

    return allNormalized;
  }
}

module.exports = {
  AshbyAdapter
};
