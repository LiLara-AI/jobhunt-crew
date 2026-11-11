'use strict';
const { BaseAtsAdapter, safeIsoDate } = require('./base-adapter');
const { normalizeJobUrl } = require('../../guardrails/dedup');

class WorkableAdapter extends BaseAtsAdapter {
  constructor(options = {}) {
    super('workable', options);
    this.defaultBaseUrl = 'https://apply.workable.com';
  }

  static parseJobs(data, account = 'company', options = {}) {
    const rawList = Array.isArray(data) ? data
      : (data && Array.isArray(data.results) ? data.results
        : (data && Array.isArray(data.jobs) ? data.jobs : []));
    const company = options.company || account;
    return rawList.filter(j => j && typeof j === 'object').map(j => {
      const jobId = String(j.id || j.shortcode || '');
      const location = [j.city, j.state, j.country].filter(Boolean).join(', ')
        || String(j.location_str || j.location || '');
      const title = String(j.title || j.name || '');
      const isRemote = j.remote === true || /remote/i.test(String(j.workplace || ''));
      const rawUrl = j.url || j.application_url || j.shortlink
        || `https://apply.workable.com/${account}/j/${j.shortcode || jobId}/`;
      return {
        id: `workable-${account}-${jobId}`,
        requisitionId: String(j.shortcode || jobId),
        title,
        company,
        url: normalizeJobUrl(rawUrl),
        location,
        remoteStatus: isRemote ? 'remote' : (/hybrid/i.test(location + ' ' + title) ? 'hybrid' : (location ? 'onsite' : 'unknown')),
        department: j.department || null,
        compensation: null,
        postedAt: safeIsoDate(j.published_at || j.created_at || j.updated_at),
        rawPayload: j,
        source: 'workable'
      };
    });
  }

  async fetchBoard(account, options = {}) {
    const base = this.baseUrl || this.defaultBaseUrl;
    const url = `${base}/api/v3/accounts/${encodeURIComponent(account)}/jobs`;
    const res = await this.fetchWithRetry(url, {
      method: 'POST',
      body: { query: options.searchText || '', location: [], department: [], worktype: [], remote: [] },
      ...options
    });
    if (!res.success || !res.data) return [];
    return WorkableAdapter.parseJobs(res.data, account, options);
  }
}

module.exports = { WorkableAdapter };
