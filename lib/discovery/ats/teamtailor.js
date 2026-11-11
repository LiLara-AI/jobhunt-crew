'use strict';
const { BaseAtsAdapter, safeIsoDate } = require('./base-adapter');
const { normalizeJobUrl } = require('../../guardrails/dedup');

class TeamtailorAdapter extends BaseAtsAdapter {
  constructor(options = {}) {
    super('teamtailor', options);
  }

  static parseJobs(data, slug = 'company', options = {}) {
    const company = options.company || slug;
    let rawList = [];
    if (Array.isArray(data)) rawList = data;
    else if (data && Array.isArray(data.jobs)) rawList = data.jobs;
    else if (data && Array.isArray(data.data)) rawList = data.data;
    else if (typeof data === 'string') {
      // Minimal RSS <item> extraction for the public /jobs.rss feed.
      const items = data.match(/<item>[\s\S]*?<\/item>/g) || [];
      rawList = items.map(block => {
        const pick = tag => {
          const m = block.match(new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${tag}>`, 'i'));
          return m ? m[1].trim() : '';
        };
        return { title: pick('title'), link: pick('link'), pubDate: pick('pubDate'), guid: pick('guid') };
      });
    }
    return rawList.filter(j => j && typeof j === 'object').map(j => {
      const attrs = j.attributes || j;
      const jobId = String(j.id || attrs.id || attrs.guid || '');
      const title = String(attrs.title || attrs.name || '');
      const location = String(attrs.location || attrs.city || '');
      const rawUrl = attrs.url || attrs.link || attrs['careersite-job-url']
        || `https://${slug}.teamtailor.com/jobs/${jobId}`;
      return {
        id: `teamtailor-${slug}-${jobId}`,
        requisitionId: jobId,
        title,
        company,
        url: normalizeJobUrl(rawUrl),
        location,
        remoteStatus: attrs.remote === true || /remote/i.test(location + ' ' + title) ? 'remote'
          : (/hybrid/i.test(location + ' ' + title) ? 'hybrid' : (location ? 'onsite' : 'unknown')),
        department: attrs.department || null,
        compensation: null,
        postedAt: safeIsoDate(attrs.published_at || attrs.pubDate || attrs.created_at),
        rawPayload: j,
        source: 'teamtailor'
      };
    });
  }

  async fetchBoard(slug, options = {}) {
    const base = this.baseUrl || `https://${slug}.teamtailor.com`;
    const res = await this.fetchWithRetry(`${base}/jobs.rss`, options);
    if (!res.success || !res.data) return [];
    return TeamtailorAdapter.parseJobs(res.data, slug, options);
  }
}

module.exports = { TeamtailorAdapter };
