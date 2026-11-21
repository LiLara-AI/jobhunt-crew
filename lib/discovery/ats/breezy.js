'use strict';
const { BaseAtsAdapter, safeIsoDate } = require('./base-adapter');
const { normalizeJobUrl } = require('../../guardrails/dedup');

class BreezyAdapter extends BaseAtsAdapter {
  constructor(options = {}) {
    super('breezy', options);
  }

  static parseJobs(data, slug = 'company', options = {}) {
    const rawList = Array.isArray(data) ? data
      : (data && Array.isArray(data.positions) ? data.positions : []);
    const company = options.company || (data && data.company && data.company.name) || slug;
    return rawList.filter(j => j && typeof j === 'object').map(j => {
      const jobId = String(j.id || j.position_id || j._id || '');
      const location = String((j.location && typeof j.location === 'object' ? j.location.name : j.location) || ([j.city, j.state, j.country].filter(Boolean).join(', ')) || '');
      const title = String(j.name || j.title || '');
      const isRemote = j.remote === true || /remote/i.test(String(j.type || '') + ' ' + location + ' ' + title);
      const rawUrl = j.url || `https://${slug}.breezy.hr/p/${jobId}`;
      return {
        id: `breezy-${slug}-${jobId}`,
        requisitionId: jobId,
        title,
        company,
        url: normalizeJobUrl(rawUrl),
        location,
        remoteStatus: isRemote ? 'remote' : (/hybrid/i.test(location + ' ' + title) ? 'hybrid' : (location ? 'onsite' : 'unknown')),
        department: j.department || j.category || null,
        compensation: j.salary || null,
        postedAt: safeIsoDate(j.published_date || j.published_at || j.created_at),
        rawPayload: j,
        source: 'breezy'
      };
    });
  }

  async fetchBoard(slug, options = {}) {
    const base = this.baseUrl || `https://${slug}.breezy.hr`;
    const res = await this.fetchWithRetry(`${base}/json`, options);
    if (!res.success || !res.data) return [];
    return BreezyAdapter.parseJobs(res.data, slug, options);
  }
}

module.exports = { BreezyAdapter, BreezyHrAdapter: BreezyAdapter };
