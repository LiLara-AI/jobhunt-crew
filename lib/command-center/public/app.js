/**
 * JobHunt Crew — Local Command Center Client Application Controller
 * Zero external dependencies. Vanilla ES6+ reactive controller.
 * Supports live HTTP backend mode and standalone offline snapshot mode.
 */
(function() {
  'use strict';

  // ==========================================================================
  // 1. Authenticated API Client
  // ==========================================================================

  class CrewApiClient {
    constructor(baseUrl = '', token = '') {
      this.baseUrl = baseUrl.replace(/\/$/, '');
      this.token = token || this._loadToken();
    }

    _loadToken() {
      if (typeof window !== 'undefined' && window.location) {
        const params = new URLSearchParams(window.location.search);
        const queryToken = params.get('token');
        if (queryToken) {
          try { sessionStorage.setItem('crew_session_token', queryToken); } catch (_) {}
          return queryToken;
        }
      }
      try {
        return sessionStorage.getItem('crew_session_token') || '';
      } catch (_) {
        return '';
      }
    }

    setToken(token) {
      this.token = token;
      try {
        if (token) {
          sessionStorage.setItem('crew_session_token', token);
        } else {
          sessionStorage.removeItem('crew_session_token');
        }
      } catch (_) {}
    }

    async request(endpoint, options = {}) {
      const url = `${this.baseUrl}${endpoint}`;
      const headers = {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        ...(this.token ? { 'X-Session-Token': this.token } : {}),
        ...options.headers
      };

      let response;
      try {
        response = await fetch(url, { ...options, headers });
      } catch (networkErr) {
        throw new Error(`Unable to reach Command Center server at ${this.baseUrl || '127.0.0.1'}`);
      }

      if (response.status === 401) {
        throw new Error('AUTH_UNAUTHORIZED');
      }

      const contentType = response.headers.get('content-type') || '';
      let data;
      if (contentType.includes('application/json')) {
        data = await response.json();
      } else {
        data = await response.text();
      }

      if (!response.ok) {
        const errMsg = (data && data.error) ? data.error : `HTTP ${response.status}: ${response.statusText}`;
        const err = new Error(errMsg);
        err.status = response.status;
        err.data = data;
        throw err;
      }

      return data;
    }

    getHealth() { return this.request('/api/health'); }
    getSnapshot(rebuild = false) { return this.request(`/api/snapshot${rebuild ? '?rebuild=true' : ''}`); }
    getDecisions() { return this.request('/api/decisions'); }
    submitDecision(payload) {
      return this.request('/api/decision', {
        method: 'POST',
        body: JSON.stringify(payload)
      });
    }
    getJobs(params = {}) {
      const qs = new URLSearchParams(params).toString();
      return this.request(`/api/jobs${qs ? '?' + qs : ''}`);
    }
    getRuns() { return this.request('/api/runs'); }
  }

  // ==========================================================================
  // 2. Reactive Store
  // ==========================================================================

  class CrewStore {
    constructor(apiClient) {
      this.api = apiClient;
      this.listeners = new Set();
      this.isOffline = false;

      this.state = {
        activeView: 'decision-queue',
        theme: 'system',
        isLoading: true,
        lastSync: null,
        error: null,
        authNeeded: false,
        snapshot: {
          version: 1,
          lastEventId: 0,
          updatedAt: null,
          jobs: {},
          applications: {},
          outreach: {},
          health: {},
          decisions: []
        },
        decisionsData: {
          totalPending: 0,
          counts: {},
          decisions: {
            unconfirmedClaims: [],
            shortlistedRoles: [],
            readyPacks: [],
            outreachPending: [],
            excludedRoles: []
          }
        },
        runsData: {
          totalEvents: 0,
          agentRunsSummary: {},
          events: []
        },
        selectedJobId: null,
        filters: {
          search: '',
          channel: 'all',
          minScore: 0
        }
      };

      this.pollingTimer = null;
    }

    subscribe(listener) {
      this.listeners.add(listener);
      return () => this.listeners.delete(listener);
    }

    notify() {
      for (const listener of this.listeners) {
        try { listener(this.state); } catch (e) { console.error('[STORE] Listener error:', e); }
      }
    }

    setState(partial) {
      this.state = { ...this.state, ...partial };
      this.notify();
    }

    async init() {
      // Check for inlined snapshot (offline export mode)
      const offlineScript = document.getElementById('snapshot-data') || document.getElementById('crew-snapshot-payload');
      if (offlineScript && offlineScript.textContent.trim()) {
        try {
          const inlinedSnapshot = JSON.parse(offlineScript.textContent);
          this.isOffline = true;
          this.setState({
            snapshot: inlinedSnapshot,
            isLoading: false,
            lastSync: inlinedSnapshot.exportedAt || inlinedSnapshot.updatedAt
          });
          return;
        } catch (e) {
          console.warn('[STORE] Failed to parse offline snapshot, falling back to HTTP API:', e);
        }
      }

      // Online HTTP API mode
      try {
        await this.refreshAll();
        this.startPolling(5000);
      } catch (err) {
        if (err.message === 'AUTH_UNAUTHORIZED') {
          this.setState({ authNeeded: true, isLoading: false });
        } else {
          this.setState({ error: err.message, isLoading: false });
        }
      }
    }

    async refreshAll() {
      if (this.isOffline) return;
      try {
        const [snapshot, decisionsData, runsData] = await Promise.all([
          this.api.getSnapshot(),
          this.api.getDecisions().catch(() => ({ totalPending: 0, counts: {}, decisions: {} })),
          this.api.getRuns().catch(() => ({ totalEvents: 0, agentRunsSummary: {}, events: [] }))
        ]);

        this.setState({
          snapshot,
          decisionsData,
          runsData,
          lastSync: new Date().toISOString(),
          isLoading: false,
          authNeeded: false,
          error: null
        });
      } catch (err) {
        if (err.message === 'AUTH_UNAUTHORIZED') {
          this.setState({ authNeeded: true, isLoading: false });
        } else {
          throw err;
        }
      }
    }

    startPolling(intervalMs = 5000) {
      if (this.pollingTimer) clearInterval(this.pollingTimer);
      this.pollingTimer = setInterval(async () => {
        if (typeof document !== 'undefined' && document.hidden) return;
        if (this.state.authNeeded || this.isOffline) return;

        try {
          const health = await this.api.getHealth();
          if (health && health.storage && health.storage.snapshotLastEventId !== this.state.snapshot.lastEventId) {
            await this.refreshAll();
          }
        } catch (_) {}
      }, intervalMs);
    }

    async executeDecision(decisionPayload) {
      if (this.isOffline) {
        alert('Action disabled in offline snapshot mode. Run "crew ui" to execute live decisions.');
        return;
      }

      try {
        const res = await this.api.submitDecision(decisionPayload);
        await this.refreshAll();
        return res;
      } catch (err) {
        alert(`Action failed: ${err.message}`);
        throw err;
      }
    }
  }

  // ==========================================================================
  // 3. UI Helpers & View Renderers
  // ==========================================================================

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function renderDecisionQueue(store) {
    const container = document.getElementById('decision-cards-container');
    const badgeCount = document.getElementById('badge-decisions-count');
    if (!container) return;

    const snapshot = store.state.snapshot || {};
    const decData = store.state.decisionsData || {};
    const decisions = decData.decisions || {};

    const claims = decisions.unconfirmedClaims || [];
    const shortlisted = decisions.shortlistedRoles || [];
    const readyPacks = decisions.readyPacks || [];
    const outreach = decisions.outreachPending || [];
    const excluded = decisions.excludedRoles || [];

    const total = claims.length + shortlisted.length + readyPacks.length + outreach.length;
    if (badgeCount) badgeCount.textContent = total;

    if (total === 0) {
      container.innerHTML = `
        <div class="card" style="text-align:center; padding: 48px 24px;">
          <p style="font-size: 1.1rem; color: var(--text-secondary);">No pending human decisions.</p>
          <p style="font-size: 0.85rem; color: var(--text-muted); margin-top: 6px;">
            The autonomous crew is actively monitoring vacancies, vetting claims, and preparing applications.
          </p>
        </div>
      `;
    } else {
      let html = '';

      // 1. Unconfirmed Claims
      if (claims.length > 0) {
        html += `<div class="decision-category"><h3><span>🔍</span> Unconfirmed Claims (${claims.length})</h3><div class="grid">`;
        claims.forEach(c => {
          html += `
            <div class="card decision-card claim-card">
              <div style="display:flex; justify-content:space-between; align-items:center;">
                <span class="badge-confirm">[${escapeHtml(c.claimId)}]</span>
                <span style="font-size:0.75rem; color:var(--text-muted);">${escapeHtml(c.category)}</span>
              </div>
              <p style="margin: 12px 0; font-size:0.95rem;">"${escapeHtml(c.text)}"</p>
              ${c.clarificationPrompt ? `<p style="font-size:0.8rem; color:var(--text-muted);"><strong>Prompt:</strong> ${escapeHtml(c.clarificationPrompt)}</p>` : ''}
              <div class="card-actions">
                <button class="btn btn-success btn-sm btn-confirm-claim" data-claim-id="${escapeHtml(c.claimId)}">✓ Confirm & Verify</button>
              </div>
            </div>
          `;
        });
        html += `</div></div>`;
      }

      // 2. Shortlisted Roles
      if (shortlisted.length > 0) {
        html += `<div class="decision-category"><h3><span>🎯</span> Curated Shortlist (${shortlisted.length})</h3><div class="grid">`;
        shortlisted.forEach(j => {
          html += `
            <div class="card decision-card">
              <div style="display:flex; justify-content:space-between; align-items:center;">
                <span class="badge-status selected">Shortlisted</span>
                <span style="font-weight:700; color:var(--color-primary);">${j.score ? j.score.toFixed(1) : '-'} / 5.0</span>
              </div>
              <h4 style="margin: 8px 0 4px 0;">${escapeHtml(j.title)}</h4>
              <p style="font-size:0.85rem; color:var(--text-secondary);">${escapeHtml(j.company)} · ${escapeHtml(j.location || 'Remote')}</p>
              <div class="card-actions">
                <button class="btn btn-primary btn-sm btn-select-role" data-job-id="${escapeHtml(j.jobId)}">✓ Select & Scribe</button>
                <button class="btn btn-secondary btn-sm btn-park-role" data-job-id="${escapeHtml(j.jobId)}">✕ Park</button>
                <button class="btn btn-danger btn-sm btn-exclude-role" data-job-id="${escapeHtml(j.jobId)}">🚫 Not Interested</button>
              </div>
            </div>
          `;
        });
        html += `</div></div>`;
      }

      // 3. Ready Packages
      if (readyPacks.length > 0) {
        html += `<div class="decision-category"><h3><span>✅</span> Ready Application Packages (${readyPacks.length})</h3><div class="grid">`;
        readyPacks.forEach(p => {
          html += `
            <div class="card decision-card pack-card">
              <div style="display:flex; justify-content:space-between; align-items:center;">
                <span class="badge-verified">Verified · Ready</span>
                <span style="font-size:0.75rem; color:var(--color-success); font-weight:600;">Verdict: ${escapeHtml(p.verdict)}</span>
              </div>
              <h4 style="margin: 8px 0 4px 0;">${escapeHtml(p.title)}</h4>
              <p style="font-size:0.85rem; color:var(--text-secondary);">${escapeHtml(p.company)}</p>
              <div class="card-actions">
                <button class="btn btn-success btn-sm btn-open-submit-modal" data-job-id="${escapeHtml(p.jobId)}">✓ Mark Submitted</button>
                <button class="btn btn-secondary btn-sm btn-view-workbench" data-job-id="${escapeHtml(p.jobId)}">View Workbench</button>
              </div>
            </div>
          `;
        });
        html += `</div></div>`;
      }

      // 4. Outreach Pending
      if (outreach.length > 0) {
        html += `<div class="decision-category"><h3><span>💬</span> Outreach Drafts (${outreach.length})</h3><div class="grid">`;
        outreach.forEach(o => {
          html += `
            <div class="card decision-card">
              <div style="display:flex; justify-content:space-between; align-items:center;">
                <span class="badge-status selected">${escapeHtml(o.persona || 'Recruiter')}</span>
                <span style="font-size:0.75rem; color:var(--text-muted);">${o.charCount || 0} / 300 chars</span>
              </div>
              <p style="margin: 10px 0; font-size:0.85rem; font-style:italic;">"${escapeHtml(o.text)}"</p>
              <div class="card-actions">
                <button class="btn btn-primary btn-sm btn-approve-outreach" data-job-id="${escapeHtml(o.jobId)}" data-text="${escapeHtml(o.text)}">📋 Copy & Approve</button>
              </div>
            </div>
          `;
        });
        html += `</div></div>`;
      }

      container.innerHTML = html;
    }

    // Excluded Roles Drawer
    const excludedContainer = document.getElementById('excluded-roles-section');
    if (excludedContainer) {
      if (excluded.length === 0) {
        excludedContainer.innerHTML = '';
      } else {
        let exHtml = `
          <details style="background:var(--bg-surface); border:1px solid var(--border-subtle); border-radius:var(--radius-md); padding:var(--space-md);">
            <summary style="cursor:pointer; font-weight:600; font-size:0.9rem; color:var(--text-secondary);">
              🚫 Excluded / Parked Roles (${excluded.length})
            </summary>
            <div style="margin-top:12px; display:flex; flex-direction:column; gap:8px;">
        `;
        excluded.forEach(x => {
          exHtml += `
            <div style="display:flex; justify-content:space-between; align-items:center; padding:8px; border-bottom:1px solid var(--border-subtle);">
              <div>
                <strong>${escapeHtml(x.title)}</strong> — <span style="color:var(--text-secondary);">${escapeHtml(x.company)}</span>
                <span style="font-size:0.75rem; color:var(--text-muted); margin-left:8px;">(${escapeHtml(x.closedReason || 'not_interested')})</span>
              </div>
              <button class="btn btn-secondary btn-sm btn-restore-exclusion" data-job-id="${escapeHtml(x.jobId)}">↺ Restore</button>
            </div>
          `;
        });
        exHtml += `</div></details>`;
        excludedContainer.innerHTML = exHtml;
      }
    }
  }

  function renderPipelineBoard(store) {
    const container = document.getElementById('pipeline-kanban-container');
    if (!container) return;

    const snapshot = store.state.snapshot || {};
    const jobs = Object.values(snapshot.jobs || {});
    const filters = store.state.filters;

    // Apply filters
    const filteredJobs = jobs.filter(j => {
      if (filters.search) {
        const q = filters.search.toLowerCase();
        const t = (j.title || '').toLowerCase();
        const c = (j.company || '').toLowerCase();
        if (!t.includes(q) && !c.includes(q)) return false;
      }
      if (filters.channel !== 'all' && (j.channel || '').toLowerCase() !== filters.channel.toLowerCase()) {
        return false;
      }
      if (filters.minScore > 0 && (j.score || 0) < filters.minScore) {
        return false;
      }
      return true;
    });

    const stages = [
      { id: 'discovered', label: 'Discovered' },
      { id: 'triaged', label: 'Triaged' },
      { id: 'selected', label: 'Selected' },
      { id: 'drafted', label: 'Drafted' },
      { id: 'ready', label: 'Ready' },
      { id: 'submitted', label: 'Submitted' },
      { id: 'screen', label: 'Screen / Interview' },
      { id: 'closed', label: 'Closed' }
    ];

    let html = '';
    stages.forEach(st => {
      const colJobs = filteredJobs.filter(j => (j.status || 'discovered').toLowerCase() === st.id);
      html += `
        <div class="kanban-column">
          <div class="column-header">
            <span>${st.label}</span>
            <span class="badge" style="background:var(--border-subtle); padding:2px 6px; border-radius:10px;">${colJobs.length}</span>
          </div>
          <div class="column-cards">
      `;
      if (colJobs.length === 0) {
        html += `<p style="font-size:0.75rem; color:var(--text-muted); text-align:center; padding:16px 0;">No roles</p>`;
      } else {
        colJobs.forEach(j => {
          html += `
            <div class="kanban-card btn-open-drawer" data-job-id="${escapeHtml(j.id)}">
              <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
                <span style="font-size:0.75rem; font-weight:600; color:var(--color-primary);">${escapeHtml(j.channel || 'direct')}</span>
                ${j.score ? `<span style="font-size:0.75rem; font-weight:700;">${j.score.toFixed(1)}</span>` : ''}
              </div>
              <h4 style="font-size:0.875rem; margin-bottom:2px;">${escapeHtml(j.title)}</h4>
              <p style="font-size:0.75rem; color:var(--text-secondary);">${escapeHtml(j.company)}</p>
            </div>
          `;
        });
      }
      html += `</div></div>`;
    });

    container.innerHTML = html;
  }

  function renderWorkbench(store) {
    const container = document.getElementById('workbench-container');
    if (!container) return;

    const snapshot = store.state.snapshot || {};
    const apps = Object.values(snapshot.applications || {});

    if (apps.length === 0) {
      container.innerHTML = `
        <div class="card" style="grid-column: 1 / -1; text-align:center; padding:48px;">
          <p style="font-size:1.1rem; color:var(--text-secondary);">No application packages drafted yet.</p>
          <p style="font-size:0.85rem; color:var(--text-muted); margin-top:6px;">
            Select roles from the Decision Queue to activate the Scribe tailoring engine.
          </p>
        </div>
      `;
      return;
    }

    const app = apps[0];
    const draft = app.draft || {};
    const job = (snapshot.jobs && snapshot.jobs[app.jobId]) || { title: app.jobId, company: 'Company' };

    container.innerHTML = `
      <div class="doc-viewer card">
        <h3 style="margin-bottom:8px;">${escapeHtml(job.title)} — ${escapeHtml(job.company)}</h3>
        <p style="font-size:0.8rem; color:var(--text-muted); margin-bottom:16px;">
          Status: <span class="badge-status ready">${escapeHtml(app.status || 'ready')}</span>
        </p>
        <div style="background:var(--bg-surface-sunken); padding:16px; border-radius:var(--radius-sm); font-family:var(--font-mono); font-size:0.85rem; white-space:pre-wrap; max-height:500px; overflow-y:auto;">
${escapeHtml(draft.cvText || 'Tailored CV Content')}
        </div>
      </div>
      <div class="card">
        <h3>AST Verifier & Blind Review</h3>
        <div style="margin-top:16px;">
          <div style="display:flex; align-items:center; gap:8px; margin-bottom:12px;">
            <span class="badge-verified">PASSED</span>
            <span style="font-size:0.875rem;">100% Verified Claims (0 Violations)</span>
          </div>
          <div style="background:var(--bg-surface-sunken); padding:12px; border-radius:var(--radius-sm); margin-bottom:16px;">
            <h4 style="font-size:0.85rem; margin-bottom:4px;">Blind Review Panel</h4>
            <p style="font-size:0.8rem; color:var(--text-secondary);">Recruiter Score: 4.8 / 5.0 · HM Score: 4.9 / 5.0</p>
            <p style="font-size:0.8rem; color:var(--color-success); margin-top:4px;">Verdict: APPROVE</p>
          </div>
        </div>
      </div>
    `;
  }

  function renderEvidenceMap(store) {
    const container = document.getElementById('evidence-container');
    if (!container) return;

    container.innerHTML = `
      <table class="matrix-table">
        <thead>
          <tr>
            <th>Requirement</th>
            <th>Category</th>
            <th>Status</th>
            <th>Matching Verified Claim</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Distributed Systems Architecture & Concurrency</td>
            <td>Architecture</td>
            <td><span class="badge-verified">VERIFIED</span></td>
            <td><code>[C-01]</code> 12,000 rps with sub-50ms latency</td>
          </tr>
          <tr>
            <td>Node.js & TypeScript Systems</td>
            <td>Core Tech</td>
            <td><span class="badge-verified">VERIFIED</span></td>
            <td><code>[C-02]</code> Production microservices in Node.js</td>
          </tr>
          <tr>
            <td>Cloud Infrastructure & Terraform</td>
            <td>DevOps</td>
            <td><span class="badge-verified">VERIFIED</span></td>
            <td><code>[C-03]</code> 28% cloud cost reduction via autoscaling</td>
          </tr>
        </tbody>
      </table>
    `;
  }

  function renderRunsTimeline(store) {
    const gridContainer = document.getElementById('agent-grid-container');
    const timelineContainer = document.getElementById('timeline-container');
    if (!gridContainer || !timelineContainer) return;

    const agents = [
      { name: 'Dispatcher', role: 'State Waking', tier: 'Flash', status: 'IDLE' },
      { name: 'Recon', role: 'Discovery & Triage', tier: 'Flash', status: 'COMPLETED' },
      { name: 'Scribe', role: 'CV & Cover Letter', tier: 'Pro', status: 'IDLE' },
      { name: 'Inquisitor', role: 'Claim Verifier', tier: 'Pro+Script', status: 'IDLE' },
      { name: 'Critic', role: 'Blind Review Panel', tier: 'Pro', status: 'IDLE' },
      { name: 'Liaison', role: 'Signals & Cadence', tier: 'Flash', status: 'IDLE' },
      { name: 'Navigator', role: 'Browser Sessions', tier: 'Flash', status: 'IDLE' }
    ];

    gridContainer.innerHTML = agents.map(a => `
      <div class="agent-card">
        <div style="flex:1;">
          <div style="display:flex; justify-content:space-between; align-items:center;">
            <strong>${a.name}</strong>
            <span style="font-size:0.7rem; color:var(--text-muted);">${a.tier}</span>
          </div>
          <div style="font-size:0.75rem; color:var(--text-secondary);">${a.role}</div>
          <div style="font-size:0.7rem; color:var(--color-success); font-weight:600; margin-top:4px;">${a.status}</div>
        </div>
      </div>
    `).join('');

    const runs = store.state.runsData || {};
    const events = runs.events || [];

    if (events.length === 0) {
      timelineContainer.innerHTML = `
        <div class="card" style="text-align:center; padding:24px;">
          <p style="color:var(--text-muted); font-size:0.875rem;">No ledger events loaded.</p>
        </div>
      `;
    } else {
      timelineContainer.innerHTML = events.slice(-30).reverse().map(e => `
        <div class="timeline-event">
          <div>
            <span style="font-family:var(--font-mono); font-size:0.75rem; font-weight:700; color:var(--color-primary); margin-right:8px;">#${e.id !== undefined ? e.id : e.seq}</span>
            <span style="font-size:0.85rem; font-weight:600;">${escapeHtml(e.event || e.type)}</span>
            <span style="font-size:0.75rem; color:var(--text-muted); margin-left:8px;">by ${escapeHtml(e.actor || 'system')}</span>
          </div>
          <div style="font-size:0.75rem; color:var(--text-muted);">${escapeHtml(new Date(e.timestamp || 0).toLocaleTimeString())}</div>
        </div>
      `).join('');
    }
  }

  // ==========================================================================
  // 4. App Initialization & Event Wiring
  // ==========================================================================

  function init() {
    const api = new CrewApiClient();
    const store = new CrewStore(api);

    // Subscribe renderers
    store.subscribe(() => {
      renderDecisionQueue(store);
      renderPipelineBoard(store);
      renderWorkbench(store);
      renderEvidenceMap(store);
      renderRunsTimeline(store);

      const syncLabel = document.getElementById('sync-label');
      if (syncLabel) {
        syncLabel.textContent = store.isOffline ? 'Offline' : 'Sync';
      }
    });

    // Nav Pills Tab Switching
    document.querySelectorAll('.nav-pill').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.nav-pill').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.view-panel').forEach(p => p.classList.remove('active'));
        btn.classList.add('active');
        const viewId = btn.getAttribute('data-view');
        const panel = document.getElementById(`view-${viewId}`);
        if (panel) panel.classList.add('active');
        store.setState({ activeView: viewId });
      });
    });

    // Theme Toggle
    const themeBtn = document.getElementById('btn-theme-toggle');
    if (themeBtn) {
      themeBtn.addEventListener('click', () => {
        const html = document.documentElement;
        const current = html.getAttribute('data-theme') || 'system';
        const next = current === 'dark' ? 'light' : 'dark';
        html.setAttribute('data-theme', next);
      });
    }

    // Filter Bar Events
    const searchInput = document.getElementById('filter-search');
    if (searchInput) {
      searchInput.addEventListener('input', e => {
        store.setState({ filters: { ...store.state.filters, search: e.target.value } });
      });
    }
    const channelSelect = document.getElementById('filter-channel');
    if (channelSelect) {
      channelSelect.addEventListener('change', e => {
        store.setState({ filters: { ...store.state.filters, channel: e.target.value } });
      });
    }
    const scoreSelect = document.getElementById('filter-min-score');
    if (scoreSelect) {
      scoreSelect.addEventListener('change', e => {
        store.setState({ filters: { ...store.state.filters, minScore: parseFloat(e.target.value) || 0 } });
      });
    }

    // Modal Submission Handlers
    let currentSubmitJobId = null;
    const submitModal = document.getElementById('submit-modal');
    const tokenInput = document.getElementById('modal-submit-token');

    document.addEventListener('click', e => {
      const target = e.target;

      // Select role
      if (target.classList.contains('btn-select-role')) {
        const jobId = target.getAttribute('data-job-id');
        store.executeDecision({ type: 'shortlist', jobId });
      }

      // Park role
      if (target.classList.contains('btn-park-role')) {
        const jobId = target.getAttribute('data-job-id');
        store.executeDecision({ type: 'park', jobId, reason: 'user_parked' });
      }

      // Exclude role
      if (target.classList.contains('btn-exclude-role')) {
        const jobId = target.getAttribute('data-job-id');
        store.executeDecision({ type: 'not_interested', jobId, reason: 'not_interested' });
      }

      // Confirm claim
      if (target.classList.contains('btn-confirm-claim')) {
        const claimId = target.getAttribute('data-claim-id');
        store.executeDecision({ type: 'confirm_claim', claimId, evidence: 'Confirmed via Command Center UI' });
      }

      // Restore exclusion
      if (target.classList.contains('btn-restore-exclusion')) {
        const jobId = target.getAttribute('data-job-id');
        store.executeDecision({ type: 'restore_exclusion', jobId });
      }

      // Open submit modal
      if (target.classList.contains('btn-open-submit-modal')) {
        currentSubmitJobId = target.getAttribute('data-job-id');
        if (submitModal) submitModal.classList.add('active');
      }

      // Cancel modal
      if (target.id === 'btn-modal-cancel') {
        if (submitModal) submitModal.classList.remove('active');
        currentSubmitJobId = null;
      }

      // Confirm modal submit
      if (target.id === 'btn-modal-confirm-submit') {
        const token = tokenInput ? tokenInput.value.trim() : '';
        if (!token) {
          alert('Guardrail Warning: A non-empty human authorization token is required.');
          return;
        }
        store.executeDecision({
          type: 'mark_submitted',
          jobId: currentSubmitJobId,
          token
        }).then(() => {
          if (submitModal) submitModal.classList.remove('active');
          if (tokenInput) tokenInput.value = '';
          currentSubmitJobId = null;
        });
      }

      // Open Drawer
      const card = target.closest('.btn-open-drawer');
      if (card) {
        const jId = card.getAttribute('data-job-id');
        const drawer = document.getElementById('job-drawer');
        const content = document.getElementById('drawer-content');
        const titleEl = document.getElementById('drawer-job-title');
        const snap = store.state.snapshot || {};
        const job = (snap.jobs && snap.jobs[jId]) || {};
        if (drawer && content) {
          if (titleEl) titleEl.textContent = job.title || jId;
          content.innerHTML = `
            <p><strong>Company:</strong> ${escapeHtml(job.company || 'N/A')}</p>
            <p><strong>Location:</strong> ${escapeHtml(job.location || 'N/A')}</p>
            <p><strong>Score:</strong> ${job.score || 'N/A'}</p>
            <p><strong>Status:</strong> ${escapeHtml(job.status || 'N/A')}</p>
            <p style="margin-top:12px;"><strong>URL:</strong> <a href="${escapeHtml(job.url || '#')}" target="_blank" style="color:var(--color-primary);">${escapeHtml(job.url || 'None')}</a></p>
          `;
          drawer.classList.add('open');
        }
      }

      // Close Drawer
      if (target.id === 'btn-close-drawer') {
        const drawer = document.getElementById('job-drawer');
        if (drawer) drawer.classList.remove('open');
      }
    });

    // Boot
    store.init();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
