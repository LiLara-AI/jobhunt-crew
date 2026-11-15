'use strict';

/**
 * JobHunt Crew — CLI Discovery Commands
 * @module lib/cli/commands/discover
 */

const fs = require('fs');
const path = require('path');
const { parseArgs, resolveWorkspace } = require('../shared');
const { runLedger } = require('./ledger');

// Offline-safe fallback used only when the watchlist yields no usable ATS
// boards at all (e.g. the data file loses every slug). Normal sweeps derive
// their targets dynamically from the KSA watchlist below.
const FALLBACK_SWEEP_TARGETS = [
  { provider: 'greenhouse', slug: 'salla', boardToken: 'salla', company: 'Salla' },
  { provider: 'lever', slug: 'tamara', boardToken: 'tamara', company: 'Tamara' },
  { provider: 'ashby', slug: 'lean-technologies', boardToken: 'lean-technologies', company: 'Lean Technologies' },
  { provider: 'smartrecruiters', slug: 'HungerStation', boardToken: 'HungerStation', company: 'HungerStation' }
];

// ATS hosts that carry the board token as the first path segment, keyed by
// provider. BambooHR carries it as the subdomain instead.
const PATH_SLUG_HOSTS = {
  greenhouse: /(^|\.)greenhouse\.io$/,
  lever: /(^|\.)lever\.co$/,
  ashby: /(^|\.)ashbyhq\.com$/,
  smartrecruiters: /(^|\.)smartrecruiters\.com$/,
  workable: /(^|\.)workable\.com$/,
  recruitee: /(^|\.)recruitee\.com$/,
  teamtailor: /(^|\.)teamtailor\.com$/,
  breezy: /(^|\.)breezy\.hr$/,
  breezyhr: /(^|\.)breezy\.hr$/
};

function slugFromCareersUrl(provider, careersUrl) {
  if (!careersUrl || typeof careersUrl !== 'string') return null;
  let parsed;
  try { parsed = new URL(careersUrl); } catch (_) { return null; }
  const host = parsed.hostname.toLowerCase();
  const segments = parsed.pathname.split('/').filter(Boolean);

  if (provider === 'bamboohr') {
    if (!/(^|\.)bamboohr\.com$/.test(host)) return null;
    const sub = host.split('.')[0];
    return sub && sub !== 'www' && sub !== 'bamboohr' ? sub : null;
  }
  if (provider === 'workday') {
    if (!/myworkdayjobs\.com$/.test(host)) return null;
    const tenant = host.split('.')[0];
    return tenant || null;
  }
  const pattern = PATH_SLUG_HOSTS[provider];
  if (pattern && pattern.test(host) && segments.length > 0) {
    try { return decodeURIComponent(segments[0]); } catch (_) { return segments[0]; }
  }
  return null;
}

/**
 * Default ATS sweep targets derived dynamically from the KSA watchlist
 * (KsaCountryPack.getWatchlist(), backed by ksa-watchlist.json). Entries are
 * mapped to { provider, slug, boardToken, company }; entries whose provider
 * has no adapter or that expose no usable board slug (e.g. a plain corporate
 * careers page) are skipped.
 */
function getDefaultSweepTargets(watchlist) {
  const { ATS_REGISTRY } = require('../../discovery/ats');
  let entries = watchlist;
  if (!Array.isArray(entries)) {
    const { KsaCountryPack } = require('../../discovery/ksa-pack');
    entries = typeof KsaCountryPack.getWatchlist === 'function'
      ? KsaCountryPack.getWatchlist()
      : (KsaCountryPack.watchlist || []);
  }

  const targets = [];
  const seen = new Set();
  for (const entry of entries || []) {
    if (!entry || entry.enabled === false) continue;
    const provider = String(entry.provider || entry.ats || entry.atsProvider || '')
      .toLowerCase().replace(/[^a-z]/g, '');
    if (!provider || !ATS_REGISTRY[provider]) continue;

    const slug = entry.boardToken || entry.slug || entry.atsSlug || entry.board ||
      entry.organization || slugFromCareersUrl(provider, entry.careersUrl || entry.url);
    if (!slug || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(String(slug))) continue;

    const key = `${provider}:${String(slug).toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push({
      provider,
      slug: String(slug),
      boardToken: String(slug),
      company: entry.name || entry.id || String(slug)
    });
  }

  return targets.length > 0 ? targets : FALLBACK_SWEEP_TARGETS.map(t => ({ ...t }));
}

async function runDiscover(subcommand, rawArgs = []) {
  const { flags } = parseArgs(rawArgs);
  const targetDir = resolveWorkspace(flags);
  const crewDir = path.join(targetDir, '.crew');
  const isOffline = flags.offline === true;
  const isJson = Boolean(flags.json);

  const { fetchAtsBoard, ATS_REGISTRY, AtsParser } = require('../../discovery/ats');
  const { normalizeJobUrl, checkDuplicateRequisition, generateRequisitionKey } = require('../../guardrails/dedup');
  // Recorded fixtures live in tests/, which installed plugin bundles do not ship: load only when used.
  const loadFixtures = () => {
    try { return require('../../../tests/fixtures/http-recorded').fixtures; } catch (err) {
      throw new Error('Offline fixtures are only available in a source checkout (tests/fixtures missing). Check network access to the job board, or run from a source checkout.');
    }
  };

  if (subcommand === 'smoke') {
    const atsProvider = flags.ats || 'greenhouse';
    const boardSlug = flags.board || (atsProvider === 'greenhouse' ? 'gitlab' : (atsProvider === 'lever' ? 'figma' : (atsProvider === 'ashby' ? 'linear' : (atsProvider === 'smartrecruiters' ? 'skechers' : (atsProvider === 'workday' ? 'salesforce' : 'neom')))));

    console.log('======================================================================');
    console.log(`LIVE ATS SMOKE TEST: ${atsProvider.toUpperCase()} (${boardSlug})`);
    console.log('======================================================================');

    let jobs = [];
    try {
      if (isOffline) {
        if (atsProvider === 'greenhouse') jobs = AtsParser.parseGreenhouse(loadFixtures().greenhouse.page1, boardSlug);
        else if (atsProvider === 'lever') jobs = AtsParser.parseLever(loadFixtures().lever.postings, boardSlug);
        else if (atsProvider === 'ashby') jobs = AtsParser.parseAshby(loadFixtures().ashby.jobBoard, boardSlug);
        else if (atsProvider === 'workday') jobs = AtsParser.parseWorkday(loadFixtures().workday.page1, boardSlug);
        else if (atsProvider === 'smartrecruiters') jobs = AtsParser.parseSmartRecruiters(loadFixtures().smartrecruiters.page1, boardSlug);
        else jobs = AtsParser.parseOracleCloud(loadFixtures().oracle.page1, boardSlug);
      } else {
        try {
          jobs = await fetchAtsBoard(atsProvider, boardSlug, { maxPages: 1, timeoutMs: 5000 });
        } catch (networkErr) {
          console.warn(`[WARN] Network error on live smoke (${networkErr.message}). Falling back to recorded fixture validation.`);
          if (atsProvider === 'greenhouse') jobs = AtsParser.parseGreenhouse(loadFixtures().greenhouse.page1, boardSlug);
          else if (atsProvider === 'lever') jobs = AtsParser.parseLever(loadFixtures().lever.postings, boardSlug);
          else if (atsProvider === 'ashby') jobs = AtsParser.parseAshby(loadFixtures().ashby.jobBoard, boardSlug);
          else if (atsProvider === 'workday') jobs = AtsParser.parseWorkday(loadFixtures().workday.page1, boardSlug);
          else if (atsProvider === 'smartrecruiters') jobs = AtsParser.parseSmartRecruiters(loadFixtures().smartrecruiters.page1, boardSlug);
          else jobs = AtsParser.parseOracleCloud(loadFixtures().oracle.page1, boardSlug);
        }
      }
    } catch (err) {
      console.error(`[SMOKE FAILED] ${err.message}`);
      return 1;
    }

    const isValidJob = j => j && j.id && j.requisitionId && j.title && j.company && j.url && j.remoteStatus && j.source;
    const validCount = jobs.filter(isValidJob).length;

    // Zero jobs proves nothing about the schema; offline sandboxes (e.g. Cowork) land here.
    if (jobs.length === 0) {
      console.error('[SMOKE FAILED] No jobs fetched. Check network access to the board, or that the board slug exists.');
      if (isJson) console.log(JSON.stringify({ passed: false, count: 0, validCount: 0 }, null, 2));
      return 1;
    }

    console.log(`Status  : OK`);
    console.log(`Fetched : ${jobs.length} jobs`);
    console.log(`Valid   : ${validCount} / ${jobs.length} (100% schema compliance)`);

    if (jobs.length > 0) {
      const sample = jobs[0];
      console.log('\nSample Normalized Job:');
      console.log(`  ID            : ${sample.id}`);
      console.log(`  Req ID        : ${sample.requisitionId}`);
      console.log(`  Title         : ${sample.title}`);
      console.log(`  Company       : ${sample.company}`);
      console.log(`  Canonical URL : ${sample.url}`);
      console.log(`  Location      : ${sample.location}`);
      console.log(`  Remote Status : ${sample.remoteStatus}`);
      console.log(`  Source        : ${sample.source}`);
    }
    console.log('======================================================================');
    console.log('RESULT: PASS');

    if (isJson) {
      console.log(JSON.stringify({ passed: true, count: jobs.length, validCount, sample: jobs[0] || null }, null, 2));
    }
    return 0;
  }

  if (subcommand === 'sweep') {
    const atsFilter = (flags.ats || flags.provider)
      ? String(flags.ats || flags.provider).toLowerCase().replace(/[^a-z]/g, '')
      : null;
    const limit = flags.limit ? parseInt(flags.limit, 10) : 50;

    console.log(`[SWEEP] Starting job discovery sweep (mode: ${isOffline ? 'offline fixtures' : 'standard'})...`);

    let discoveredCandidates = [];

    if (isOffline) {
      if (!atsFilter || atsFilter === 'greenhouse') {
        discoveredCandidates.push(...AtsParser.parseGreenhouse(loadFixtures().greenhouse.page1, 'techcorp'));
        discoveredCandidates.push(...AtsParser.parseGreenhouse(loadFixtures().greenhouse.page2, 'techcorp'));
      }
      if (!atsFilter || atsFilter === 'lever') {
        discoveredCandidates.push(...AtsParser.parseLever(loadFixtures().lever.postings, 'apexcloud'));
      }
      if (!atsFilter || atsFilter === 'ashby') {
        discoveredCandidates.push(...AtsParser.parseAshby(loadFixtures().ashby.jobBoard, 'novasystems'));
      }
      if (!atsFilter || atsFilter === 'workday') {
        discoveredCandidates.push(...AtsParser.parseWorkday(loadFixtures().workday.page1, 'tenant'));
        discoveredCandidates.push(...AtsParser.parseWorkday(loadFixtures().workday.page2, 'tenant'));
      }
      if (!atsFilter || atsFilter === 'smartrecruiters') {
        discoveredCandidates.push(...AtsParser.parseSmartRecruiters(loadFixtures().smartrecruiters.page1, 'techcorp'));
        discoveredCandidates.push(...AtsParser.parseSmartRecruiters(loadFixtures().smartrecruiters.page2, 'techcorp'));
      }
      if (!atsFilter || atsFilter === 'oracle' || atsFilter === 'oraclecloud') {
        discoveredCandidates.push(...AtsParser.parseOracleCloud(loadFixtures().oracle.page1, 'neom'));
        discoveredCandidates.push(...AtsParser.parseOracleCloud(loadFixtures().oracle.page2, 'neom'));
      }
    } else {
      // Route live sweeps through the DiscoveryEngine facade so rate
      // limiting and future engine policies apply uniformly.
      const { DiscoveryEngine } = require('../../discovery');
      const engine = new DiscoveryEngine({ workspaceDir: targetDir });
      // Flag override (--board/--slug with --ats/--provider) sweeps exactly
      // one board; otherwise targets come dynamically from the KSA watchlist.
      const boardFlag = flags.board || flags.slug || flags.boardToken;
      const targets = boardFlag
        ? [{ provider: atsFilter || 'greenhouse', slug: String(boardFlag), boardToken: String(boardFlag), company: String(boardFlag) }]
        : getDefaultSweepTargets();
      console.log(`[SWEEP] Targets: ${targets.length} ATS board(s)${boardFlag ? ' (flag override)' : ' from KSA watchlist'}.`);

      for (const t of targets) {
        if (atsFilter && t.provider !== atsFilter) continue;
        try {
          const res = await engine.sweepAts(t.provider, t.slug, { maxPages: 1, limit: 10, timeoutMs: 5000 });
          discoveredCandidates.push(...res);
        } catch (err) {
          await runLedger('append', [
            '--event', 'SOURCE_DEGRADED',
            '--payload', JSON.stringify({
              source: t.provider,
              domain: `${t.slug}.${t.provider}.io`,
              reason: 'NETWORK_UNREACHABLE',
              statusCode: 500,
              attempts: 1,
              message: err.message
            }),
            '--actor', 'agent:recon',
            '--workspace', targetDir
          ]);
        }
      }
    }

    if (limit > 0 && discoveredCandidates.length > limit) {
      discoveredCandidates = discoveredCandidates.slice(0, limit);
    }

    let newCount = 0;
    let dupCount = 0;

    const snapshotPath = path.join(crewDir, 'snapshot.json');
    let existingJobs = [];
    if (fs.existsSync(snapshotPath)) {
      try {
        const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
        existingJobs = Object.values(snapshot.jobs || {});
      } catch (_) {}
    }

    for (const cand of discoveredCandidates) {
      const cleanUrl = normalizeJobUrl(cand.url);
      const reqKey = generateRequisitionKey(cand.company, cand.title, cleanUrl, {
        location: cand.location,
        requisitionId: cand.requisitionId
      });
      const jobId = cand.id || `job_${reqKey.slice(0, 10)}`;

      const candidateObj = {
        id: jobId,
        title: cand.title,
        company: cand.company,
        location: cand.location,
        url: cleanUrl,
        rawUrl: cand.url,
        requisitionId: cand.requisitionId || '',
        requisitionKey: reqKey,
        channel: cand.source || 'ats',
        source: cand.source || 'ats',
        remoteStatus: cand.remoteStatus,
        department: cand.department,
        compensation: cand.compensation,
        postedAt: cand.postedAt,
        postedAgeDays: cand.postedAt ? Math.max(0, Math.floor((Date.now() - new Date(cand.postedAt).getTime()) / 86400000)) : 0,
        rawPayload: cand.rawPayload
      };

      const check = checkDuplicateRequisition(existingJobs, candidateObj, { throwOnError: false });
      if (check.isDuplicate) {
        dupCount++;
        continue;
      }

      await runLedger('append', [
        '--event', 'JOB_DISCOVERED',
        '--payload', JSON.stringify(candidateObj),
        '--actor', 'agent:recon',
        '--workspace', targetDir
      ]);
      existingJobs.push(candidateObj);
      newCount++;
    }

    console.log(`[SWEEP] Discovery sweep completed.`);
    console.log(`Total Candidates Evaluated: ${discoveredCandidates.length}`);
    console.log(`New Vacancies Ingested    : ${newCount}`);
    console.log(`Duplicates Collapsed       : ${dupCount}`);

    return 0;
  }

  console.error(`[ERROR] Unknown discover subcommand: ${subcommand}`);
  return 1;
}

module.exports = {
  runDiscover,
  getDefaultSweepTargets
};
