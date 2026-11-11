'use strict';

/**
 * JobHunt Crew â€” Greenhouse ATS Adapter
 *
 * Scrapes public board JSON endpoint:
 * GET https://boards-api.greenhouse.io/v1/boards/{board}/jobs?content=true&page={page}
 *
 * @module lib/discovery/ats/greenhouse
 */

const { BaseAtsAdapter, safeIsoDate } = require('./base-adapter');
const { normalizeJobUrl } = require('../../guardrails/dedup');

class GreenhouseAdapter extends BaseAtsAdapter {
  constructor(options = {}) {
    super('greenhouse', options);
    this.defaultBaseUrl = 'https://boards-api.greenhouse.io';
  }

  /**
   * Parses raw Greenhouse API response into normalized jobs.
   */
  static parseJobs(data, boardToken = 'company', options = {}) {
    const rawJobs = Array.isArray(data) ? data : (data && Array.isArray(data.jobs) ? data.jobs : []);
    const company = options.company || boardToken;

    return rawJobs
      .filter(job => job && typeof job === 'object')
      .map(job => {
      const jobId = String(job.id);
      const reqId = job.requisition_id ||
        (Array.isArray(job.metadata) ? job.metadata.find(m => /req/i.test(m.name))?.value : null) ||
        jobId;

      const location = job.location ? (job.location.name || '') : '';
      const dept = (Array.isArray(job.departments) && job.departments[0]?.name) ||
        (Array.isArray(job.metadata) ? job.metadata.find(m => /dep/i.test(m.name))?.value : null) ||
        null;

      const compMeta = Array.isArray(job.metadata)
        ? job.metadata.find(m => /compensation|salary/i.test(m.name))?.value
        : null;

      const rawUrl = job.absolute_url || `https://boards.greenhouse.io/${boardToken}/jobs/${jobId}`;
      const cleanUrl = normalizeJobUrl(rawUrl);

      return {
        id: `greenhouse-${boardToken}-${jobId}`,
        requisitionId: String(reqId),
        title: String(job.title || ''),
        company,
        url: cleanUrl,
        location,
        remoteStatus: /remote/i.test(location + ' ' + (job.title || '')) ? 'remote' : (/hybrid/i.test(location) ? 'hybrid' : (location ? 'onsite' : 'unknown')),
        department: dept,
        compensation: compMeta || null,
        postedAt: safeIsoDate(job.updated_at),
        rawPayload: job,
        source: 'greenhouse'
      };
    });
  }

  /**
   * Fetches all active jobs for a Greenhouse board, traversing pages.
   */
  async fetchBoard(boardToken, options = {}) {
    const base = this.baseUrl || this.defaultBaseUrl;

    const allNormalized = await this.paginate(async ({ page }) => {
      const url = `${base}/v1/boards/${encodeURIComponent(boardToken)}/jobs?content=true&page=${page}`;
      const res = await this.fetchWithRetry(url, options);

      if (!res.success || !res.data) {
        return { items: [], hasMore: false };
      }

      const jobs = GreenhouseAdapter.parseJobs(res.data, boardToken, options);
      const rawList = Array.isArray(res.data) ? res.data : (res.data.jobs || []);

      // Greenhouse returns empty array when pages end
      const hasMore = rawList.length > 0 && jobs.length > 0;
      return {
        items: jobs,
        hasMore
      };
    }, options);

    return allNormalized;
  }
}

module.exports = {
  GreenhouseAdapter
};
