'use strict';

/**
 * JobHunt Crew — Offline Single-File Dashboard Exporter
 * Bundles the Command Center UI and materialized snapshot into a portable,
 * standalone HTML file with zero remote dependencies.
 *
 * Location: lib/command-center/exporter.js
 */

const fs = require('fs');
const path = require('path');
const { replayLedger } = require('../ledger/reducer');

/**
 * Validates that an HTML string contains zero remote asset URLs or CDN links.
 * Throws an Error if any remote reference is detected.
 *
 * @param {string} html - Inlined HTML content
 * @returns {boolean} true if verification passes
 */
function verifyZeroRemoteAssets(html) {
  if (typeof html !== 'string') {
    throw new Error('EXPORT_SECURITY_VIOLATION: Expected HTML content string');
  }

  // Scope security verification to the UI shell by excluding the inlined data snapshot
  // so legitimate job descriptions or notes mentioning CDN domains do not cause false positives
  const targetHtml = html.replace(/<script\b[^>]*id=["']snapshot-data["'][^>]*>[\s\S]*?<\/script>/gi, '');

  const remotePatterns = [
    /(?:src|href|data)\s*=\s*(?:["']\s*)?(?:https?:|\/\/)/i,
    /url\s*\(\s*['"]?\s*(?:https?:|\/\/)/i,
    /@import\s+/i,
    /(?:fonts\.googleapis\.com|fonts\.gstatic\.com|cdnjs\.cloudflare\.com|unpkg\.com|jsdelivr\.net)/i
  ];

  for (const pattern of remotePatterns) {
    if (pattern.test(targetHtml)) {
      throw new Error(`EXPORT_SECURITY_VIOLATION: Remote asset detected in export matching pattern ${pattern}`);
    }
  }

  return true;
}

/**
 * Safely sanitizes JSON text for embedding within a <script type="application/json"> tag.
 * Replaces all '<' characters with RFC 8259-compliant '\\u003c' unicode escapes,
 * preventing HTML parser breakout while remaining natively parseable via JSON.parse().
 *
 * @param {Object|string} data - Snapshot object or JSON string to sanitize
 * @returns {string} Sanitized JSON string
 */
function serializeSnapshotSafely(data) {
  const json = typeof data === 'string' ? data : JSON.stringify(data);
  return json.replace(/</g, '\\u003c');
}

/**
 * Fallback HTML template in case public assets are unavailable.
 */
function getFallbackTemplate() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>JobHunt Crew — Command Center (Offline Snapshot)</title>
  <link rel="stylesheet" href="styles.css">
</head>
<body>
  <div id="offline-banner" class="offline-banner">
    <div class="banner-content">
      <span class="badge badge-offline">OFFLINE SNAPSHOT</span>
      <span id="export-timestamp-label">Exported: {{EXPORT_TIMESTAMP}}</span>
      <span class="separator">·</span>
      <span id="export-seq-label">Ledger Sequence: #{{LAST_EVENT_ID}}</span>
      <span class="separator">·</span>
      <span class="banner-note">Read-Only Mode (Run <code>crew ui</code> for live decisions)</span>
    </div>
  </div>

  <header class="app-header">
    <div class="brand">
      <div class="logo-icon">⚡</div>
      <div class="brand-text">
        <h1>JobHunt Crew</h1>
        <span class="subtitle">Command Center</span>
      </div>
    </div>
    <nav class="view-nav">
      <button class="nav-tab active" data-view="decision-queue">Decision Queue</button>
      <button class="nav-tab" data-view="pipeline-board">Pipeline Board</button>
      <button class="nav-tab" data-view="workbench">Workbench</button>
      <button class="nav-tab" data-view="evidence-map">Evidence Map</button>
      <button class="nav-tab" data-view="runs-timeline">Runs Timeline</button>
    </nav>
  </header>

  <main class="app-main">
    <section id="view-decision-queue" class="view-panel active">
      <h2>Decision Queue</h2>
      <div class="cards-grid" id="decision-cards-container"></div>
    </section>
    <section id="view-pipeline-board" class="view-panel">
      <h2>Pipeline Board</h2>
      <div class="kanban-grid" id="pipeline-kanban-container"></div>
    </section>
    <section id="view-workbench" class="view-panel">
      <h2>Workbench</h2>
      <div id="workbench-container"></div>
    </section>
    <section id="view-evidence-map" class="view-panel">
      <h2>Evidence Map</h2>
      <div id="evidence-container"></div>
    </section>
    <section id="view-runs-timeline" class="view-panel">
      <h2>Runs Timeline</h2>
      <div id="timeline-container"></div>
    </section>
  </main>

  <script src="app.js"></script>
</body>
</html>`;
}

/**
 * Fallback CSS styles matching system typography and dark/light mode.
 */
function getFallbackStyles() {
  return `:root {
  --bg-primary: #0f172a;
  --bg-secondary: #1e293b;
  --bg-card: #334155;
  --text-primary: #f8fafc;
  --text-secondary: #94a3b8;
  --border-color: #475569;
  --accent-blue: #38bdf8;
  --accent-green: #4ade80;
  --font-system: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
}
@media (prefers-color-scheme: light) {
  :root {
    --bg-primary: #f8fafc;
    --bg-secondary: #ffffff;
    --bg-card: #f1f5f9;
    --text-primary: #0f172a;
    --text-secondary: #475569;
    --border-color: #e2e8f0;
    --accent-blue: #0284c7;
    --accent-green: #16a34a;
  }
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: var(--font-system); background-color: var(--bg-primary); color: var(--text-primary); line-height: 1.5; padding: 16px; }
.offline-banner { background: #b45309; color: #fff; padding: 8px 16px; border-radius: 6px; margin-bottom: 16px; font-size: 0.875rem; }
.app-header { display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--border-color); padding-bottom: 12px; margin-bottom: 20px; }
.view-nav { display: flex; gap: 8px; }
.nav-tab { background: var(--bg-secondary); border: 1px solid var(--border-color); color: var(--text-primary); padding: 8px 14px; border-radius: 6px; cursor: pointer; }
.nav-tab.active { background: var(--accent-blue); color: #000; font-weight: 600; }
.view-panel { display: none; }
.view-panel.active { display: block; }
.card { background: var(--bg-secondary); border: 1px solid var(--border-color); border-radius: 8px; padding: 16px; margin-bottom: 12px; }`;
}

/**
 * Fallback client script.
 */
function getFallbackScript() {
  return `(function() {
  'use strict';
  document.addEventListener('DOMContentLoaded', function() {
    var snapshotEl = document.getElementById('snapshot-data');
    var snapshot = snapshotEl ? JSON.parse(snapshotEl.textContent) : { jobs: {}, applications: {}, decisions: [] };
    var tabs = document.querySelectorAll('.nav-tab');
    tabs.forEach(function(tab) {
      tab.addEventListener('click', function() {
        tabs.forEach(function(t) { t.classList.remove('active'); });
        document.querySelectorAll('.view-panel').forEach(function(p) { p.classList.remove('active'); });
        tab.classList.add('active');
        var view = tab.getAttribute('data-view');
        var panel = document.getElementById('view-' + view);
        if (panel) panel.classList.add('active');
      });
    });
  });
})();`;
}

/**
 * Generates the complete standalone, single-file HTML export.
 *
 * @param {Object} options
 * @param {string} [options.workspace] - Path to workspace directory
 * @param {string} [options.outFile] - Destination output file path
 * @param {Object} [options.snapshot] - Optional pre-loaded snapshot object
 * @param {string} [options.publicDir] - Optional directory containing public UI assets
 * @returns {Promise<{ html: string, outFile?: string, sizeBytes: number, exportedAt: string, lastEventId: number, jobCount: number }>}
 */
async function exportDashboard(options = {}) {
  const workspaceDir = options.workspace ? path.resolve(options.workspace) : process.cwd();
  const crewDir = path.join(workspaceDir, '.crew');
  const snapshotPath = path.join(crewDir, 'snapshot.json');
  const ledgerPath = path.join(crewDir, 'ledger.jsonl');

  // 1. Resolve or compute fresh snapshot
  let snapshot = options.snapshot;
  if (!snapshot) {
    if (fs.existsSync(ledgerPath)) {
      snapshot = await replayLedger({
        workspaceDir,
        ledgerPath,
        snapshotPath,
        rebuild: false
      });
    } else if (fs.existsSync(snapshotPath)) {
      try {
        snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
      } catch (_) {
        snapshot = { version: 1, lastEventId: 0, updatedAt: new Date().toISOString(), jobs: {}, applications: {}, decisions: [], health: {} };
      }
    } else {
      snapshot = {
        version: 1,
        lastEventId: 0,
        updatedAt: new Date().toISOString(),
        jobs: {},
        applications: {},
        decisions: [],
        health: {}
      };
    }
  }

  const exportedAt = new Date().toISOString();
  const lastEventId = snapshot.lastEventId || 0;
  const jobCount = Object.keys(snapshot.jobs || {}).length;

  const exportPayload = {
    ...snapshot,
    exportedAt,
    mode: 'offline-snapshot'
  };

  // 2. Resolve HTML template, CSS styles, and client JS
  const publicDir = options.publicDir ? path.resolve(options.publicDir) : path.join(__dirname, 'public');
  let htmlTemplate = getFallbackTemplate();
  let cssContent = getFallbackStyles();
  let jsContent = getFallbackScript();

  const indexPath = path.join(publicDir, 'index.html');
  const stylesPath = path.join(publicDir, 'styles.css');
  const altStylePath = path.join(publicDir, 'style.css');
  const appJsPath = path.join(publicDir, 'app.js');

  if (fs.existsSync(indexPath)) {
    htmlTemplate = fs.readFileSync(indexPath, 'utf8');
  }
  if (fs.existsSync(stylesPath)) {
    cssContent = fs.readFileSync(stylesPath, 'utf8');
  } else if (fs.existsSync(altStylePath)) {
    cssContent = fs.readFileSync(altStylePath, 'utf8');
  }
  if (fs.existsSync(appJsPath)) {
    jsContent = fs.readFileSync(appJsPath, 'utf8');
  }

  // 3. Inline CSS: Replace <link rel="stylesheet" ...> with <style>...</style>
  let inlinedHtml = htmlTemplate;
  const linkRegex = /<link\s+[^>]*rel=["']stylesheet["'][^>]*\/?>/i;
  if (linkRegex.test(inlinedHtml)) {
    inlinedHtml = inlinedHtml.replace(linkRegex, `<style>\n${cssContent}\n</style>`);
  } else if (inlinedHtml.includes('</head>')) {
    inlinedHtml = inlinedHtml.replace('</head>', `<style>\n${cssContent}\n</style>\n</head>`);
  } else {
    inlinedHtml = `<style>\n${cssContent}\n</style>\n` + inlinedHtml;
  }

  // 4. Inline Snapshot Data safely before client script
  const sanitizedJson = serializeSnapshotSafely(exportPayload);
  const dataScriptTag = `<script type="application/json" id="snapshot-data">\n${sanitizedJson}\n</script>`;

  // 5. Inline JavaScript: Replace <script ... src="...app.js"...></script> with dataScript + <script>...</script>
  const scriptRegex = /<script\s+[^>]*src=["'][^"']*app\.js["'][^>]*><\/script>/i;
  if (scriptRegex.test(inlinedHtml)) {
    inlinedHtml = inlinedHtml.replace(scriptRegex, `${dataScriptTag}\n<script>\n${jsContent}\n</script>`);
  } else if (inlinedHtml.includes('</body>')) {
    inlinedHtml = inlinedHtml.replace('</body>', `${dataScriptTag}\n<script>\n${jsContent}\n</script>\n</body>`);
  } else {
    inlinedHtml += `\n${dataScriptTag}\n<script>\n${jsContent}\n</script>`;
  }

  // 6. Replace template placeholders
  inlinedHtml = inlinedHtml
    .replace(/{{EXPORT_TIMESTAMP}}/g, exportedAt)
    .replace(/{{LAST_EVENT_ID}}/g, String(lastEventId));

  // 7. Security verification: Ensure zero remote assets
  verifyZeroRemoteAssets(inlinedHtml);

  // 8. Write to output file if requested
  let outFile = options.outFile;
  if (outFile) {
    outFile = path.resolve(outFile);
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, inlinedHtml, 'utf8');
  }

  return {
    html: inlinedHtml,
    outFile,
    sizeBytes: Buffer.byteLength(inlinedHtml, 'utf8'),
    exportedAt,
    lastEventId,
    jobCount
  };
}

module.exports = {
  exportDashboard,
  verifyZeroRemoteAssets,
  serializeSnapshotSafely
};
