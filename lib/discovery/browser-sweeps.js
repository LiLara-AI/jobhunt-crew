'use strict';

/**
 * JobHunt Crew — Attended Browser Sweeps & Session Diagnostics
 *
 * Implements attended Chrome DevTools MCP sweep helpers for authenticated job boards:
 * LinkedIn, Bayt, GulfTalent, Naukrigulf, and Indeed SA.
 *
 * Strict Attended Protocol:
 * - Read-only navigation and extraction.
 * - Zero automated credential handling or password typing.
 * - Emits clear human instructions upon detecting login walls or expired sessions.
 *
 * @module lib/discovery/browser-sweeps
 */

const { normalizeJobUrl } = require('../guardrails/dedup');

const SUPPORTED_BOARDS = {
  linkedin: {
    id: 'linkedin',
    name: 'LinkedIn Jobs',
    domain: 'www.linkedin.com',
    searchUrlTemplate: 'https://www.linkedin.com/jobs/search/?keywords={query}&location={location}',
    checkUrl: 'https://www.linkedin.com/feed/',
    loggedInSelector: 'nav.global-nav, #global-nav, .global-nav__me',
    loginWallSelector: 'button.sign-in-modal__outlet-btn, input#session_key, form.login__form',
    loginUrl: 'https://www.linkedin.com/login',
    itemSelector: '.jobs-search__results-list li, .job-card-container',
    pacingMs: 2500
  },
  bayt: {
    id: 'bayt',
    name: 'Bayt.com',
    domain: 'www.bayt.com',
    searchUrlTemplate: 'https://www.bayt.com/en/international/jobs/{query}-jobs-in-{location}/',
    checkUrl: 'https://www.bayt.com/en/my-bayt/',
    loggedInSelector: '#myBaytNav, .u-menu, .nav-user',
    loginWallSelector: '#loginForm, a[href*="/en/login/"]',
    loginUrl: 'https://www.bayt.com/en/login/',
    itemSelector: '.has-pointer-d, .js-job-card',
    pacingMs: 2000
  },
  gulftalent: {
    id: 'gulftalent',
    name: 'GulfTalent',
    domain: 'www.gulftalent.com',
    searchUrlTemplate: 'https://www.gulftalent.com/saudi-arabia/jobs?pos_title={query}',
    checkUrl: 'https://www.gulftalent.com/candidates/my-account',
    loggedInSelector: '.candidate-menu, #nav-user-name, a[href*="/candidates/logout"]',
    loginWallSelector: 'form#login-form, a[href*="/candidates/login"]',
    loginUrl: 'https://www.gulftalent.com/candidates/login',
    itemSelector: 'table.table-striped tbody tr, .job-row',
    pacingMs: 2000
  },
  naukrigulf: {
    id: 'naukrigulf',
    name: 'Naukrigulf',
    domain: 'www.naukrigulf.com',
    searchUrlTemplate: 'https://www.naukrigulf.com/{query}-jobs-in-saudi-arabia',
    checkUrl: 'https://www.naukrigulf.com/my-naukrigulf',
    loggedInSelector: '.user-profile-name, .logged-in, #user-logged-in',
    loginWallSelector: '.login-popup, a[href*="/login"]',
    loginUrl: 'https://www.naukrigulf.com/login',
    itemSelector: '.srp-tuple, .job-tuple',
    pacingMs: 2000
  },
  indeed: {
    id: 'indeed',
    name: 'Indeed Saudi Arabia',
    domain: 'sa.indeed.com',
    searchUrlTemplate: 'https://sa.indeed.com/jobs?q={query}&l={location}',
    checkUrl: 'https://sa.indeed.com/',
    loggedInSelector: '#AccountMenu, .gnav-AccountMenu',
    loginWallSelector: 'a[href*="/account/login"]',
    loginUrl: 'https://sa.indeed.com/account/login',
    itemSelector: '.job_seen_beacon, .jobsearch-ResultsList > li',
    pacingMs: 2500
  }
};

class BrowserSweeps {
  static getTargetBoards() {
    return Object.keys(SUPPORTED_BOARDS);
  }

  static getBoardSpec(boardKey) {
    const key = boardKey === 'indeed_sa' ? 'indeed' : boardKey;
    const b = SUPPORTED_BOARDS[key];
    if (!b) return null;
    return {
      ...b,
      checkSessionSelectors: {
        loggedIn: b.loggedInSelector,
        loginWall: b.loginWallSelector
      }
    };
  }

  /**
   * Generates formatted human guidance prompt when an authentication wall is encountered.
   */
  static generateAttendedGuidance(boardKey) {
    const config = SUPPORTED_BOARDS[boardKey] || {
      name: boardKey,
      loginUrl: `https://${boardKey}.com/login`,
      id: boardKey
    };

    return [
      '======================================================================',
      `ATTENDED BROWSER ACTION REQUIRED: ${config.name.toUpperCase()}`,
      '======================================================================',
      `Board   : ${config.name}`,
      'Status  : Authentication session required or expired.',
      'Security: Zero automated password typing. Human session required.',
      'Action  :',
      '  1. Open Google Chrome (with Chrome DevTools extension enabled).',
      `  2. Navigate to: ${config.loginUrl}`,
      '  3. Log in to your personal account (and complete 2FA if prompted).',
      '  4. Once signed in, rerun the discovery sweep:',
      `     node bin/crew.js discover sweep --channel ${config.id}`,
      '======================================================================'
    ].join('\n');
  }

  /**
   * Evaluates browser session status from HTML or DOM probe result.
   *
   * @param {string} boardKey - 'linkedin' | 'bayt' | 'gulftalent' | 'naukrigulf' | 'indeed'
   * @param {object} probeResult - { html, loggedInFound, loginWallFound }
   * @returns {object} { authenticated: boolean, needsLogin: boolean, guidance: string|null }
   */
  static evaluateSessionHealth(boardKey, probeResult = {}) {
    const config = SUPPORTED_BOARDS[boardKey];
    if (!config) {
      return { authenticated: true, needsLogin: false, guidance: null };
    }

    const html = String(probeResult.html || '');
    let isLoggedIn = probeResult.loggedInFound === true;
    let isLoginWall = probeResult.loginWallFound === true;

    if (!probeResult.loggedInFound && html) {
      if (boardKey === 'linkedin') {
        isLoggedIn = /global-nav__me|feed-identity-module/i.test(html);
        isLoginWall = /sign-in-modal|session_key|login__form/i.test(html);
      } else if (boardKey === 'bayt') {
        isLoggedIn = /myBaytNav|nav-user|u-menu/i.test(html);
        isLoginWall = /loginForm|login-box/i.test(html);
      } else if (boardKey === 'gulftalent') {
        isLoggedIn = /candidate-menu|nav-user-name|logout/i.test(html);
        isLoginWall = /login-form|login-box/i.test(html);
      } else if (boardKey === 'naukrigulf') {
        isLoggedIn = /user-profile-name|user-logged-in/i.test(html);
        isLoginWall = /login-popup|ng-login/i.test(html);
      } else if (boardKey === 'indeed') {
        isLoggedIn = /gnav-AccountMenu|AccountMenu/i.test(html);
        isLoginWall = /account\/login/i.test(html);
      }
    }

    const authenticated = isLoggedIn && !isLoginWall;
    return {
      authenticated,
      needsLogin: !authenticated,
      guidance: !authenticated ? BrowserSweeps.generateAttendedGuidance(boardKey) : null
    };
  }

  /**
   * Builds search URL for target board, query, and location.
   */
  static buildSearchUrl(boardKey, query, location = 'Riyadh, Saudi Arabia') {
    const config = SUPPORTED_BOARDS[boardKey];
    if (!config) return null;

    const encQuery = encodeURIComponent(query);
    const encLoc = encodeURIComponent(location);

    return config.searchUrlTemplate
      .replace('{query}', encQuery)
      .replace('{location}', encLoc);
  }

  /**
   * Normalizes raw items extracted from browser DOM into standard schema candidates.
   */
  static normalizeBrowserListing(rawListing, boardKey) {
    const title = String(rawListing.title || '').trim();
    const company = String(rawListing.company || '').trim();
    const location = String(rawListing.location || '').trim();
    const rawUrl = rawListing.url || '';
    const cleanUrl = normalizeJobUrl(rawUrl);

    return {
      title,
      company,
      location,
      url: cleanUrl,
      rawUrl,
      source: boardKey,
      channel: boardKey,
      remoteStatus: /remote/i.test(location + ' ' + title) ? 'remote' : (/hybrid/i.test(location + ' ' + title) ? 'hybrid' : (location ? 'onsite' : 'unknown'))
    };
  }
}

module.exports = {
  BrowserSweeps,
  SUPPORTED_BOARDS
};
