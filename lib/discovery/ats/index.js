'use strict';

/**
 * JobHunt Crew — Modular ATS Registry & Ingestion Engine
 *
 * Unifies direct ATS scraping across Greenhouse, Lever, Ashby,
 * Workday, SmartRecruiters, and Oracle Cloud HCM into a standardized contract.
 *
 * @module lib/discovery/ats
 */

const { BaseAtsAdapter } = require('./base-adapter');
const { GreenhouseAdapter } = require('./greenhouse');
const { LeverAdapter } = require('./lever');
const { AshbyAdapter } = require('./ashby');
const { WorkdayAdapter } = require('./workday');
const { SmartRecruitersAdapter } = require('./smartrecruiters');
const { OracleCloudAdapter } = require('./oracle-cloud');
const { WorkableAdapter } = require('./workable');
const { RecruiteeAdapter } = require('./recruitee');
const { TeamtailorAdapter } = require('./teamtailor');
const { BreezyAdapter } = require('./breezy');
const { BambooHrAdapter } = require('./bamboohr');

const ATS_REGISTRY = {
  greenhouse: GreenhouseAdapter,
  lever: LeverAdapter,
  ashby: AshbyAdapter,
  workday: WorkdayAdapter,
  smartrecruiters: SmartRecruitersAdapter,
  oracle: OracleCloudAdapter,
  oraclecloud: OracleCloudAdapter,
  workable: WorkableAdapter,
  recruitee: RecruiteeAdapter,
  teamtailor: TeamtailorAdapter,
  breezy: BreezyAdapter,
  breezyhr: BreezyAdapter,
  bamboohr: BambooHrAdapter
};

/**
 * Fetches all active vacancies from an ATS board.
 *
 * @param {string} provider - 'greenhouse' | 'lever' | 'ashby' | 'workday' | 'smartrecruiters' | 'oracle'
 * @param {string|object} target - Slug/tenant string or config object { tenant, site, board, organization, company }
 * @param {object} [options] - Options { baseUrl, maxPages, limit, host }
 * @returns {Promise<Array<object>>} Normalized job objects
 */
async function fetchAtsBoard(provider, target, options = {}) {
  const normProvider = String(provider || '').toLowerCase().replace(/[^a-z]/g, '');
  const AdapterClass = ATS_REGISTRY[normProvider];

  if (!AdapterClass) {
    throw new Error(`Unsupported ATS provider: "${provider}". Supported: ${Object.keys(ATS_REGISTRY).join(', ')}`);
  }

  const adapter = new AdapterClass(options);

  if (normProvider === 'workday') {
    const tenant = typeof target === 'string' ? target : (target.tenant || target.slug || target.company);
    const site = typeof target === 'object' && target.site ? target.site : (options.site || 'External_Career_Site');
    return adapter.fetchBoard(tenant, site, { ...options, ...(typeof target === 'object' ? target : {}) });
  }

  const slug = typeof target === 'string' ? target : (target.slug || target.board || target.organization || target.company || target.tenant);
  return adapter.fetchBoard(slug, { ...options, ...(typeof target === 'object' ? target : {}) });
}

/**
 * Legacy/Simple parser helpers for test assertions and offline fixture parsing.
 */
class AtsParser {
  static parseGreenhouse(data, board = 'techcorp', options = {}) {
    return GreenhouseAdapter.parseJobs(data, board, options);
  }

  static parseLever(postings, site = 'apexcloud', options = {}) {
    return LeverAdapter.parseJobs(postings, site, options);
  }

  static parseAshby(data, org = 'novasystems', options = {}) {
    return AshbyAdapter.parseJobs(data, org, options);
  }

  static parseWorkday(data, tenant = 'tenant', options = {}) {
    return WorkdayAdapter.parseJobs(data, tenant, options);
  }

  static parseSmartRecruiters(data, company = 'techcorp', options = {}) {
    return SmartRecruitersAdapter.parseJobs(data, company, options);
  }

  static parseOracleCloud(data, tenant = 'neom', options = {}) {
    return OracleCloudAdapter.parseJobs(data, tenant, options);
  }

  static parseOracle(data, tenant = 'neom', options = {}) {
    return OracleCloudAdapter.parseJobs(data, tenant, options);
  }

  static parseWorkable(data, account = 'company', options = {}) {
    return WorkableAdapter.parseJobs(data, account, options);
  }

  static parseRecruitee(data, slug = 'company', options = {}) {
    return RecruiteeAdapter.parseJobs(data, slug, options);
  }

  static parseTeamtailor(data, slug = 'company', options = {}) {
    return TeamtailorAdapter.parseJobs(data, slug, options);
  }

  static parseBreezy(data, slug = 'company', options = {}) {
    return BreezyAdapter.parseJobs(data, slug, options);
  }

  static parseBambooHr(data, slug = 'company', options = {}) {
    return BambooHrAdapter.parseJobs(data, slug, options);
  }
}

module.exports = {
  ATS_REGISTRY,
  BaseAtsAdapter,
  GreenhouseAdapter,
  LeverAdapter,
  AshbyAdapter,
  WorkdayAdapter,
  SmartRecruitersAdapter,
  OracleCloudAdapter,
  WorkableAdapter,
  RecruiteeAdapter,
  TeamtailorAdapter,
  BreezyAdapter,
  BambooHrAdapter,
  fetchAtsBoard,
  fetchAtsJobs: fetchAtsBoard,
  AtsParser
};
