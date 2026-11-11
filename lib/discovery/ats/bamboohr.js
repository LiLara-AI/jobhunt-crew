'use strict';
const { BaseAtsAdapter, safeIsoDate } = require('./base-adapter');
const { normalizeJobUrl } = require('../../guardrails/dedup');

class BambooHrAdapter extends BaseAtsAdapter {
  constructor(options = {}) {
    super('bamboohr', options);
  }

  static parseJobs(data, slug = 'company', options = {}) {
    const rawList = Array.isArray(data) ? data
      : (data && Array.isArray(data.result) ? data.result
        : (data && Array.isArray(data.jobs) ? data.jobs : []));
    const company = options.company || slug;
    return rawList.filter(j => j && typeof j === 'object').map(j => {
      const jobId = String(j.id || j.jobId || '');
      const loc = j.location && typeof j.location === 'object'
        ? [j.location.city, j.location.state, j.location.country].filter(Boolean).join(', ')
        : String(j.location || '');
      const title = String(j.jobOpeningName || j.title || j.name || '');
      const rawUrl = j.jobOpeningShareUrl || j.url || `https://${slug}.bamboohr.com/careers/${jobId}`;
      return {
        id: `bamboohr-${slug}-${jobId}`,
        requisitionId: jobId,
        title,
        company,
        url: normalizeJobUrl(rawUrl),
        location: loc,
        remoteStatus: j.isRemote === true || /remote/i.test(loc + ' ' + title) ? 'remote'
          : (/hybrid/i.test(loc + ' ' + title) ? 'hybrid' : (loc ? 'onsite' : 'unknown')),
        department: j.departmentLabel || j.department || null,
        compensation: null,
        postedAt: safeIsoDate(j.datePosted || j.postedAt || j.createdAt),
        rawPayload: j,
        source: 'bamboohr'
      };
    });
  }

  async fetchBoard(slug, options = {}) {
    const base = this.baseUrl || `https://${slug}.bamboohr.com`;
    const res = await this.fetchWithRetry(`${base}/careers/list`, options);
    if (!res.success || !res.data) return [];
    return BambooHrAdapter.parseJobs(res.data, slug, options);
  }
}

module.exports = { BambooHrAdapter, BambooHRAdapter: BambooHrAdapter };
