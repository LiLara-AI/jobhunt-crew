#!/usr/bin/env node
'use strict';

/**
 * JobHunt Crew — Native MCP Server Executable
 *
 * Runs the JobHunt Crew stdio Model Context Protocol (MCP) server.
 * Usage: node bin/crew-mcp.js [--workspace <dir>]
 */

const path = require('path');
const { McpServer } = require('../lib/mcp/server');

function main() {
  const args = process.argv.slice(2);
  let workspace = process.cwd();

  const wsIdx = args.indexOf('--workspace');
  if (wsIdx !== -1 && args[wsIdx + 1]) {
    workspace = path.resolve(args[wsIdx + 1]);
  } else {
    const wIdx = args.indexOf('-w');
    if (wIdx !== -1 && args[wIdx + 1]) {
      workspace = path.resolve(args[wIdx + 1]);
    }
  }

  const server = new McpServer({ workspace });
  server.start();
}

if (require.main === module) {
  main();
}

module.exports = { main };
