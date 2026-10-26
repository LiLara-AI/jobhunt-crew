'use strict';

/**
 * JobHunt Crew — Oracle Cloud HCM (Candidate Experience) ATS Adapter
 *
 * Scrapes public Candidate Experience REST API:
 * GET https://{host}/hcmRestApi/resources/latest/recruitingCEJobRequisitions?onlyData=true&expand=all&limit={limit}&offset={offset}
 *
 * @module lib/discovery/ats/oracle-cloud
 */

const { BaseAtsAdapter } = require('./base-adapter');
const { normalizeJobUrl } = require('../dedup.js');

class OracleCloudAdapter extends BaseAtsAdapter {
  constructor(options = {}) {
    super('oracle', options);
  }

  /**
   * Parses Oracle Cloud HCM response into normalized jobs.
   */
  static parseJobs(data, tenant = 'tenant', options = {}) {
    const items = Array.isArray(data) ? data : (data && Array.isArray(data.items) ? data.items : []);
    const company = options.company || tenant;

    return items
      .filter(item => item && typeof item === 'object')
      .map(item => {
      const reqId = item.RequisitionNumber || String(item.Id || '');
      const title = item.PostingTitle || item.Title || '';
      const location = item.PrimaryLocation || '';
      const dept = item.JobFamily || item.Department || null;

      let compensation = null;
      if (item.MinimumSalary !== undefined && item.MaximumSalary !== undefined) {
        compensation = `${item.MinimumSalary} - ${item.MaximumSalary} ${item.CurrencyCode || 'SAR'}`;
      }

      let remoteStatus = 'unknown';
      const workOpt = String(item.WorkLocationOption || '').toUpperCase();
      if (workOpt === 'REMOTE' || /remote/i.test(location + ' ' + title)) {
        remoteStatus = 'remote';
      } else if (workOpt === 'HYBRID' || /hybrid/i.test(location + ' ' + title)) {
        remoteStatus = 'hybrid';
      } else if (workOpt === 'ONSITE' || location) {
        remoteStatus = 'onsite';
      }

      const rawUrl = item.ExternalURL || `https://careers.${tenant}.com/job/${reqId}`;
      const cleanUrl = normalizeJobUrl(rawUrl);

      return {
        id: `oracle-${tenant}-${reqId}`,
        requisitionId: String(reqId),
        title: String(title),
        company,
        url: cleanUrl,
        location,
        remoteStatus,
        department: dept,
        compensation,
        postedAt: item.PostedDate ? new Date(item.PostedDate).toISOString() : null,
        rawPayload: item,
        source: 'oracle'
      };
    });
  }

  /**
   * Fetches all active requisitions from Oracle Cloud HCM.
   */
  async fetchBoard(tenant, options = {}) {
    const host = options.host || `careers.${tenant}.com`;
    const base = this.baseUrl || `https://${host}`;
    const limit = options.limit || 25;

    const allNormalized = await this.paginate(async ({ offset }) => {
      const endpoint = `${base}/hcmRestApi/resources/latest/recruitingCEJobRequisitions?onlyData=true&expand=all&limit=${limit}&offset=${offset}`;
      const res = await this.fetchWithRetry(endpoint, options);

      if (!res.success || !res.data) {
        return { items: [], hasMore: false };
      }

      const jobs = OracleCloudAdapter.parseJobs(res.data, tenant, options);
      const hasMore = res.data.hasMore === true || ((offset + limit) < (res.data.totalResults || 0));

      return {
        items: jobs,
        hasMore: hasMore && jobs.length > 0,
        nextOffset: offset + limit
      };
    }, options);

    return allNormalized;
  }
}

module.exports = {
  OracleCloudAdapter,
  OracleAdapter: OracleCloudAdapter
};
