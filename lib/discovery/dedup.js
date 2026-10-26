'use strict';

/**
 * JobHunt Crew — Discovery Deduplication Module
 * Re-exports and extends core deduplication and URL canonicalization.
 *
 * @module lib/discovery/dedup
 */

const coreDedup = require('../guardrails/dedup');

module.exports = {
  ...coreDedup
};
