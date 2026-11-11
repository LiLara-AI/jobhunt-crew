'use strict';

/**
 * JobHunt Crew â€” SmartRecruiters ATS Adapter
 *
 * Scrapes public postings JSON endpoint:
 * GET https://api.smartrecruiters.com/v1/companies/{company}/postings?limit={limit}&offset={offset}
 *
 * @module lib/discovery/ats/smartrecruiters
 */

const { BaseAtsAdapter, safeIsoDate } = require('./base-adapter');
const { normalizeJobUrl } = require('../../guardrails/dedup');

class SmartRecruitersAdapter extends BaseAtsAdapter {
  constructor(options = {}) {
    super('smartrecruiters', options);
    this.defaultBaseUrl = 'https://api.smartrecruiters.com';
  }

  /**
   * Parses SmartRecruiters raw response into normalized jobs.
   */
  static parseJobs(data, companyIdentifier = 'company', options = {}) {
    const rawList = Array.isArray(data) ? data : (data && Array.isArray(data.content) ? data.content : []);
    const company = options.company || companyIdentifier;

    return rawList
      .filter(job => job && typeof job === 'object')
      .map(job => {
      const jobId = String(job.id);
      const reqId = job.refNumber || jobId;

      let location = '';
      if (job.location) {
        const parts = [job.location.city, job.location.region, job.location.country ? job.location.country.toUpperCase() : '']
          .filter(Boolean);
        location = parts.join(', ');
      }

      const dept = job.department ? (job.department.label || job.department.name || null) : null;

      let compensation = null;
      if (job.compensation) {
        compensation = `${job.compensation.min || ''} - ${job.compensation.max || ''} ${job.compensation.currency || ''}`.trim() || null;
      }

      let remoteStatus = 'unknown';
      if (job.location && job.location.remote === true) {
        remoteStatus = 'remote';
      } else if (/remote/i.test(location + ' ' + (job.name || ''))) {
        remoteStatus = 'remote';
      } else if (/hybrid/i.test(location + ' ' + (job.name || ''))) {
        remoteStatus = 'hybrid';
      } else if (location) {
        remoteStatus = 'onsite';
      }

      const rawUrl = job.postingUrl || (job.actions && job.actions.details) || `https://jobs.smartrecruiters.com/${companyIdentifier}/${jobId}`;
      const cleanUrl = normalizeJobUrl(rawUrl);

      return {
        id: `smartrecruiters-${companyIdentifier}-${jobId}`,
        requisitionId: String(reqId),
        title: String(job.name || job.title || ''),
        company,
        url: cleanUrl,
        location,
        remoteStatus,
        department: dept,
        compensation,
        postedAt: safeIsoDate(job.releasedDate),
        rawPayload: job,
        source: 'smartrecruiters'
      };
    });
  }

  /**
   * Fetches all active postings for a SmartRecruiters company.
   */
  async fetchBoard(companyIdentifier, options = {}) {
    const base = this.baseUrl || this.defaultBaseUrl;
    const limit = options.limit || 10;

    const allNormalized = await this.paginate(async ({ offset }) => {
      const url = `${base}/v1/companies/${encodeURIComponent(companyIdentifier)}/postings?limit=${limit}&offset=${offset}`;
      const res = await this.fetchWithRetry(url, options);

      if (!res.success || !res.data) {
        return { items: [], hasMore: false };
      }

      const jobs = SmartRecruitersAdapter.parseJobs(res.data, companyIdentifier, options);
      const totalFound = res.data.totalFound !== undefined ? res.data.totalFound : jobs.length;
      const hasMore = (offset + limit) < totalFound && jobs.length > 0;

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
  SmartRecruitersAdapter
};
