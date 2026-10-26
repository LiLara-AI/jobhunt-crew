'use strict';

/**
 * JobHunt Crew Core Entry Point
 * @module jobhunt-crew
 */

const { VERSION } = require('../bin/crew');
const discovery = require('./discovery');

module.exports = {
  VERSION,
  name: 'jobhunt-crew',
  discovery
};
