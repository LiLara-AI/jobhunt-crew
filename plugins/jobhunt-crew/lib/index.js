'use strict';

/**
 * JobHunt Crew Core Entry Point
 * @module jobhunt-crew
 */

const { VERSION } = require('./cli/shared'); // not ../bin: the Claude bundle ships bin/ as cli/
const ledgerModule = require('./ledger/ledger');
const reducerModule = require('./ledger/reducer');
const lockModule = require('./ledger/lock');
const honestCv = require('./honest-cv');
const discovery = require('./discovery');
const commandCenterServer = require('./command-center/server');
const commandCenterExporter = require('./command-center/exporter');
const backup = require('./operational/backup');
const alerts = require('./operational/alerts');
const retrospective = require('./operational/retrospective');
const diagnostics = require('./operational/diagnostics');
const contacts = require('./operational/contacts');
const migrateLegacy = require('./operational/migrate-legacy');
const outreach = require('./crew/outreach');
const interviewStoryBank = require('./crew/interview-story-bank');
const ksaOffer = require('./crew/ksa-offer');
const cadence = require('./crew/cadence');

const ledger = {
  ...ledgerModule,
  ...reducerModule,
  ...lockModule
};

const commandCenter = {
  ...commandCenterServer,
  ...commandCenterExporter,
  server: commandCenterServer,
  exporter: commandCenterExporter
};

const operational = {
  ...backup,
  ...alerts,
  ...retrospective,
  ...diagnostics,
  ...contacts,
  ...migrateLegacy,
  backup,
  alerts,
  retrospective,
  diagnostics,
  contacts,
  migrateLegacy
};

const crew = {
  ...outreach,
  ...interviewStoryBank,
  ...ksaOffer,
  ...cadence,
  outreach,
  interviewStoryBank,
  ksaOffer,
  cadence
};

module.exports = {
  VERSION,
  name: 'jobhunt-crew',
  ledger,
  honestCv,
  discovery,
  commandCenter,
  operational,
  crew,
  contacts
};
