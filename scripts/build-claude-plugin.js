#!/usr/bin/env node
'use strict';

/**
 * JobHunt Crew — Claude Plugin Build Script
 *
 * Compiles the Claude Code & Cowork plugin package from clean-room source files.
 *
 * Usage:
 *   node scripts/build-claude-plugin.js [--workspace <dir>] [--out <dir>] [--zip]
 */

const path = require('path');
const { ClaudePluginCompiler } = require('../lib/compiler/claude-plugin');

async function main() {
  const args = process.argv.slice(2);
  let workspace = path.resolve(__dirname, '..');
  let outDir = path.join(workspace, 'dist', 'claude-plugin');
  let doZip = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--workspace' && i + 1 < args.length) {
      workspace = path.resolve(args[++i]);
    } else if (args[i] === '--out' && i + 1 < args.length) {
      outDir = path.resolve(args[++i]);
    } else if (args[i] === '--zip') {
      doZip = true;
    }
  }

  console.log('[COMPILER] Building Claude Code/Cowork plugin bundle...');
  console.log(`  Source Workspace : ${workspace}`);
  console.log(`  Target Output    : ${outDir}`);

  const compiler = new ClaudePluginCompiler({
    workspaceDir: workspace,
    outDir,
    zip: doZip
  });

  const result = await compiler.build();
  console.log(`[COMPILER] Build completed successfully:`);
  console.log(`  Manifest   : ${result.manifestPath}`);
  console.log(`  Rules      : ${result.rulesPath}`);
  console.log(`  Skills     : ${result.skillsCount} skills compiled`);
  if (result.zipPath) {
    console.log(`  Zip Bundle : ${result.zipPath}`);
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error(`[COMPILER] Build failed: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { main };
