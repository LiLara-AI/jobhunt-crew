'use strict';

/**
 * JobHunt Crew — Workday CXS ATS Adapter
 *
 * Scrapes public Candidate Experience JSON endpoint:
 * POST https://{host}/wday/cxs/{tenant}/{site}/jobs
 *
 * @module lib/discovery/ats/workday
 */

const { BaseAtsAdapter } = require('./base-adapter');
const { normalizeJobUrl } = require('../dedup.js');

class WorkdayAdapter extends BaseAtsAdapter {
  constructor(options = {}) {
    super('workday', options);
  }

  /**
   * Helper to parse postedOn text (e.g., "Posted 120 Days Ago", "Posted Today") into ISO timestamp.
   */
  static parsePostedDate(postedOn) {
    if (!postedOn || typeof postedOn !== 'string') return null;
    const match = postedOn.match(/(\d+)\s+days?\s+ago/i);
    if (match) {
      const days = parseInt(match[1], 10);
      const d = new Date(Date.now() - days * 86400000);
      return d.toISOString();
    }
    if (/today/i.test(postedOn)) {
      return new Date().toISOString();
    }
    if (/yesterday/i.test(postedOn)) {
      return new Date(Date.now() - 86400000).toISOString();
    }
    const directDate = Date.parse(postedOn);
    if (!isNaN(directDate)) {
      return new Date(directDate).toISOString();
    }
    return null;
  }

  /**
   * Parses Workday raw job postings into normalized jobs.
   */
  static parseJobs(data, tenant = 'tenant', options = {}) {
    const rawList = Array.isArray(data) ? data : (data && Array.isArray(data.jobPostings) ? data.jobPostings : []);
    const host = options.host || `${tenant}.wd1.myworkdayjobs.com`;
    const company = options.company || tenant;

    return rawList
      .filter(job => job && typeof job === 'object')
      .map(job => {
      const bullet0 = Array.isArray(job.bulletFields) && job.bulletFields[0] ? String(job.bulletFields[0]).trim() : '';
      let reqId = bullet0;
      if (!reqId && job.externalPath) {
        const match = job.externalPath.match(/_([A-Z0-9_-]+)$/i) || job.externalPath.match(/\/([A-Z0-9_-]+)$/i);
        if (match) reqId = match[1];
      }
      if (!reqId) {
        reqId = job.title ? job.title.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 30) : 'unknown';
      }

      const location = job.locationsText || (Array.isArray(job.bulletFields) && job.bulletFields[1] ? String(job.bulletFields[1]).trim() : '');
      const dept = Array.isArray(job.bulletFields) && job.bulletFields[2] ? String(job.bulletFields[2]).trim() : null;

      const pathStr = job.externalPath || '';
      const fullUrl = pathStr.startsWith('http') ? pathStr : `https://${host}${pathStr.startsWith('/') ? '' : '/'}${pathStr}`;
      const cleanUrl = normalizeJobUrl(fullUrl);

      return {
        id: `workday-${tenant}-${reqId}`,
        requisitionId: String(reqId),
        title: String(job.title || ''),
        company,
        url: cleanUrl,
        location,
        remoteStatus: /remote/i.test(location + ' ' + (job.title || '')) ? 'remote' : (/hybrid/i.test(location) ? 'hybrid' : (location ? 'onsite' : 'unknown')),
        department: dept,
        compensation: null,
        postedAt: WorkdayAdapter.parsePostedDate(job.postedOn),
        rawPayload: job,
        source: 'workday'
      };
    });
  }

  /**
   * Fetches all active jobs for a Workday tenant and career site.
   */
  async fetchBoard(tenant, site = 'External_Career_Site', options = {}) {
    const host = options.host || `${tenant}.wd1.myworkdayjobs.com`;
    const base = this.baseUrl || `https://${host}`;
    const limit = options.limit || 20;

    const allNormalized = await this.paginate(async ({ offset }) => {
      const endpoint = `${base}/wday/cxs/${encodeURIComponent(tenant)}/${encodeURIComponent(site)}/jobs`;
      const body = {
        appliedFacets: {},
        limit,
        offset,
        searchText: options.searchText || ''
      };

      const res = await this.fetchWithRetry(endpoint, {
        method: 'POST',
        body,
        ...options
      });

      if (!res.success || !res.data) {
        return { items: [], hasMore: false };
      }

      const jobs = WorkdayAdapter.parseJobs(res.data, tenant, { ...options, host });
      const total = res.data.total !== undefined ? res.data.total : jobs.length;
      const hasMore = (offset + limit) < total && jobs.length > 0;

      return {
        items: jobs,
        hasMore,
        nextOffset: offset + limit
      };
    }, options);

    return allNormalized;
  }
}

module.exports = {
  WorkdayAdapter
};
