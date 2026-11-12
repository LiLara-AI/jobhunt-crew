'use strict';
const { BaseAtsAdapter, safeIsoDate } = require('./base-adapter');
const { normalizeJobUrl } = require('../../guardrails/dedup');

class RecruiteeAdapter extends BaseAtsAdapter {
  constructor(options = {}) {
    super('recruitee', options);
  }

  static parseJobs(data, slug = 'company', options = {}) {
    const rawList = Array.isArray(data) ? data
      : (data && Array.isArray(data.offers) ? data.offers : []);
    const company = options.company || slug;
    return rawList.filter(j => j && typeof j === 'object').map(j => {
      const jobId = String(j.id || j.slug || '');
      const locs = Array.isArray(j.locations) ? j.locations.map(l => (l && l.name) || '').filter(Boolean) : [];
      const location = locs.join(', ') || String(j.location || j.city || '');
      const title = String(j.title || j.name || '');
      const rawUrl = j.careers_url || j.careers_apply_url || `https://${slug}.recruitee.com/o/${j.slug || jobId}`;
      return {
        id: `recruitee-${slug}-${jobId}`,
        requisitionId: jobId,
        title,
        company,
        url: normalizeJobUrl(rawUrl),
        location,
        remoteStatus: j.remote === true || /remote/i.test(location + ' ' + title) ? 'remote'
          : (/hybrid/i.test(location + ' ' + title) ? 'hybrid' : (location ? 'onsite' : 'unknown')),
        department: (j.department && (j.department.name || j.department)) || null,
        compensation: null,
        postedAt: safeIsoDate(j.published_at || j.created_at),
        rawPayload: j,
        source: 'recruitee'
      };
    });
  }

  async fetchBoard(slug, options = {}) {
    const base = this.baseUrl || `https://${slug}.recruitee.com`;
    const res = await this.fetchWithRetry(`${base}/api/offers/`, options);
    if (!res.success || !res.data) return [];
    return RecruiteeAdapter.parseJobs(res.data, slug, options);
  }
}

module.exports = { RecruiteeAdapter };
