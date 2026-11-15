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
    getDossier() { return this.request('/api/dossier'); }
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
        dossier: null,
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
            dossier: inlinedSnapshot.dossier || null,
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
        const [snapshot, decisionsData, runsData, dossier] = await Promise.all([
          this.api.getSnapshot(),
          this.api.getDecisions().catch(() => ({ totalPending: 0, counts: {}, decisions: {} })),
          this.api.getRuns().catch(() => ({ totalEvents: 0, agentRunsSummary: {}, events: [] })),
          this.api.getDossier().catch(() => null)
        ]);

        this.setState({
          snapshot,
          decisionsData,
          runsData,
          dossier: dossier || snapshot.dossier || this.state.dossier || null,
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

  function metricText(metric) {
    if (metric === null || metric === undefined) return '';
    if (typeof metric === 'object') {
      const value = metric.value !== undefined ? metric.value : '';
      const unit = metric.unit || '';
      return `${value}${unit ? ' ' + unit : ''}`.trim();
    }
    return String(metric);
  }

  function getDossierClaims(store) {
    const dossier = store.state.dossier || (store.state.snapshot && store.state.snapshot.dossier) || null;
    if (dossier && Array.isArray(dossier.claims) && dossier.claims.length > 0) {
      return dossier.claims.map(c => ({
        claimId: c.id || c.claimId || c.tag || '',
        category: c.category || 'general',
        status: c.status || 'VERIFIED',
        text: c.text || '',
        metrics: Array.isArray(c.metrics) ? c.metrics.map(metricText).filter(Boolean) : []
      }));
    }
    // Live fallback when no dossier endpoint is available: unconfirmed claims
    // from the decisions feed plus claim ids cited by drafted applications.
    const claims = [];
    const decData = store.state.decisionsData || {};
    const pending = (decData.decisions && decData.decisions.unconfirmedClaims) || [];
    pending.forEach(c => claims.push({
      claimId: c.claimId || c.id || '', category: c.category || 'general',
      status: 'CONFIRM', text: c.text || '', metrics: []
    }));
    const apps = Object.values((store.state.snapshot && store.state.snapshot.applications) || {});
    const seen = new Set(claims.map(c => c.claimId));
    apps.forEach(app => {
      const used = (app.draft && app.draft.claimsUsed) || [];
      used.forEach(id => {
        const clean = String(id).replace(/^\[|\]$/g, '');
        if (!seen.has(clean)) {
          seen.add(clean);
          claims.push({ claimId: clean, category: 'cited in draft', status: 'VERIFIED', text: `Cited by application ${app.jobId || ''}`, metrics: [] });
        }
      });
    });
    return claims;
  }

  function computeFunnel(store) {
    const snapshot = store.state.snapshot || {};
    if (snapshot.dashboard && snapshot.dashboard.funnel) return snapshot.dashboard.funnel;
    const jobs = Object.values(snapshot.jobs || {});
    const apps = Object.values(snapshot.applications || {});
    const byStatus = {};
    jobs.forEach(j => {
      const status = String(j.status || 'discovered').toLowerCase();
      byStatus[status] = (byStatus[status] || 0) + 1;
    });
    const shortlisted = (byStatus.shortlisted || 0) + (byStatus.selected || 0);
    const ready = (byStatus.ready || 0) + apps.filter(a => a.status === 'ready').length;
    const submitted = (byStatus.submitted || 0) + (byStatus.applied || 0) + apps.filter(a => a.status === 'submitted').length;
    const pct = (n, d) => (d ? Number(((n / d) * 100).toFixed(1)) : 0);
    return {
      byStatus, totalJobs: jobs.length, totalApplications: apps.length,
      stages: [
        { id: 'discovered', label: 'Discovered', count: jobs.length },
        { id: 'shortlisted', label: 'Shortlisted', count: shortlisted },
        { id: 'ready', label: 'Ready Packs', count: ready },
        { id: 'submitted', label: 'Submitted', count: submitted },
        { id: 'closed', label: 'Closed', count: byStatus.closed || 0 }
      ],
      conversion: {
        discoveredToShortlisted: pct(shortlisted, jobs.length),
        shortlistedToReady: pct(ready, shortlisted),
        readyToSubmitted: pct(submitted, ready),
        discoveredToSubmitted: pct(submitted, jobs.length)
      }
    };
  }

  function switchView(store, viewId) {
    document.querySelectorAll('.nav-pill, .nav-tab').forEach(b => {
      const active = b.getAttribute('data-view') === viewId;
      b.classList.toggle('active', active);
      if (b.hasAttribute('aria-selected')) b.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    document.querySelectorAll('.view-panel').forEach(p => p.classList.remove('active'));
    const panel = document.getElementById(`view-${viewId}`);
    if (panel) panel.classList.add('active');
    store.setState({ activeView: viewId });
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

    const funnel = computeFunnel(store);
    const funnelHtml = `
      <div class="card" style="margin-bottom:16px;">
        <h3 style="margin-bottom:8px;">Funnel Conversion</h3>
        <div style="display:flex; flex-wrap:wrap; gap:12px; font-size:0.85rem;">
          ${funnel.stages.map(s => `<span><strong>${s.count}</strong> ${escapeHtml(s.label)}</span>`).join('<span aria-hidden="true">→</span>')}
        </div>
        <p style="font-size:0.8rem; color:var(--text-secondary); margin-top:8px;">
          Discovered → Shortlisted ${funnel.conversion.discoveredToShortlisted}% ·
          Shortlisted → Ready ${funnel.conversion.shortlistedToReady}% ·
          Ready → Submitted ${funnel.conversion.readyToSubmitted}% ·
          End to end ${funnel.conversion.discoveredToSubmitted}%
        </p>
      </div>
    `;
    const funnelContainer = document.getElementById('funnel-container');
    if (funnelContainer) funnelContainer.innerHTML = funnelHtml;

    let html = funnelContainer ? '' : funnelHtml;
    // Ledger statuses (reducer + triage verdicts) mapped onto board columns;
    // unknown values fall back to Discovered so no job silently disappears.
    const STAGE_OF = { shortlisted: 'triaged', parked: 'triaged', pass: 'triaged', fail: 'triaged', preparing: 'drafted', interview: 'screen' };
    const stageIds = new Set(stages.map(s => s.id));
    const stageOf = (status) => {
      const k = String(status || 'discovered').toLowerCase();
      return STAGE_OF[k] || (stageIds.has(k) ? k : 'discovered');
    };
    stages.forEach(st => {
      const colJobs = filteredJobs.filter(j => stageOf(j.status) === st.id);
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

    const selectedId = store.state.selectedJobId;
    const app = apps.find(a => a.jobId === selectedId) || apps[0];
    const draft = app.draft || {};
    const job = (snapshot.jobs && snapshot.jobs[app.jobId]) || { title: app.jobId, company: 'Company' };
    const verification = app.verification || null;
    const review = app.review || null;
    const claimsUsed = Array.isArray(draft.claimsUsed) ? draft.claimsUsed : [];
    const dossierClaims = getDossierClaims(store);
    const claimById = {};
    dossierClaims.forEach(c => { claimById[c.claimId] = c; });

    const selectorOptions = apps.map(candidate => {
      const candidateJob = (snapshot.jobs && snapshot.jobs[candidate.jobId]) || {};
      const label = `${candidateJob.title || candidate.jobId} — ${candidateJob.company || ''} (${candidate.status || 'drafted'})`;
      const selected = candidate.jobId === app.jobId ? ' selected' : '';
      return `<option value="${escapeHtml(candidate.jobId)}"${selected}>${escapeHtml(label)}</option>`;
    }).join('');

    const verificationBadge = verification
      ? `<span class="${verification.passed ? 'badge-verified' : 'badge-confirm'}">${verification.passed ? 'PASSED' : 'NEEDS ATTENTION'}</span>
         <span style="font-size:0.875rem;">${verification.violationsCount || 0} violation(s) · ${claimsUsed.length} claim(s) cited</span>`
      : `<span class="badge-confirm">NOT VERIFIED YET</span>
         <span style="font-size:0.875rem;">${claimsUsed.length} claim(s) cited</span>`;

    const reviewHtml = review
      ? `<p style="font-size:0.8rem; color:var(--text-secondary);">Panel Score: ${review.score !== undefined && review.score !== null ? escapeHtml(review.score) : '—'} / 5.0</p>
         <p style="font-size:0.8rem; color:var(--color-success); margin-top:4px;">Verdict: ${escapeHtml(review.verdict || 'PENDING')}</p>
         ${review.recruiterFeedback ? `<p style="font-size:0.8rem; margin-top:6px;"><strong>Recruiter:</strong> ${escapeHtml(review.recruiterFeedback)}</p>` : ''}
         ${review.hiringManagerFeedback ? `<p style="font-size:0.8rem; margin-top:4px;"><strong>Hiring Manager:</strong> ${escapeHtml(review.hiringManagerFeedback)}</p>` : ''}`
      : `<p style="font-size:0.8rem; color:var(--text-secondary);">No blind review recorded for this application yet.</p>`;

    const citedHtml = claimsUsed.length > 0
      ? claimsUsed.map(id => {
          const clean = String(id).replace(/^\[|\]$/g, '');
          const known = claimById[clean];
          const status = known ? known.status : 'UNKNOWN';
          return `<li style="font-size:0.8rem;"><code>[${escapeHtml(clean)}]</code> ${escapeHtml(status)}${known && known.text ? ` — ${escapeHtml(known.text)}` : ''}</li>`;
        }).join('')
      : '<li style="font-size:0.8rem; color:var(--text-muted);">No claims cited in this draft.</li>';

    container.innerHTML = `
      <div class="card" style="grid-column: 1 / -1;">
        <label for="workbench-app-selector" style="font-weight:600; font-size:0.85rem;">Application</label>
        <select id="workbench-app-selector" style="margin-left:8px; padding:6px 10px;">
          ${selectorOptions}
        </select>
      </div>
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
            ${verificationBadge}
          </div>
          <ul style="margin:0 0 16px 16px;">${citedHtml}</ul>
          <div style="background:var(--bg-surface-sunken); padding:12px; border-radius:var(--radius-sm); margin-bottom:16px;">
            <h4 style="font-size:0.85rem; margin-bottom:4px;">Blind Review Panel</h4>
            ${reviewHtml}
          </div>
        </div>
      </div>
    `;
  }

  function renderEvidenceMap(store) {
    const container = document.getElementById('evidence-container');
    if (!container) return;

    const snapshot = store.state.snapshot || {};
    const claims = getDossierClaims(store);
    const profileSync = (snapshot.dashboard && snapshot.dashboard.profileSync) || null;
    const verified = claims.filter(c => c.status === 'VERIFIED').length;
    const pending = claims.filter(c => c.status === 'CONFIRM').length;

    const syncHtml = `
      <div class="card" style="margin-bottom:16px;">
        <h3 style="margin-bottom:6px;">Profile Sync</h3>
        <p style="font-size:0.85rem; color:var(--text-secondary);">
          Dossier ${profileSync && profileSync.dossierPresent === false && claims.length === 0 ? 'not loaded' : 'loaded'} ·
          ${claims.length} claim(s) · ${verified} verified · ${pending} awaiting confirmation ·
          Snapshot event #${snapshot.lastEventId || 0}
          ${profileSync && profileSync.updatedAt ? ` · Profile updated ${escapeHtml(profileSync.updatedAt)}` : ''}
        </p>
        <p style="font-size:0.8rem; margin-top:4px;">${pending === 0 ? 'All loaded claims are verified.' : 'Unconfirmed claims stay out of generated packs until a human confirms them.'}</p>
      </div>
    `;
    const syncContainer = document.getElementById('profile-sync-container');
    if (syncContainer) syncContainer.innerHTML = syncHtml;

    if (claims.length === 0) {
      container.innerHTML = `${syncContainer ? '' : syncHtml}
        <div class="card" style="text-align:center; padding:32px;">
          <p style="color:var(--text-secondary);">No dossier claims loaded yet.</p>
          <p style="font-size:0.85rem; color:var(--text-muted); margin-top:6px;">Claims appear here once a candidate dossier is available to the Command Center.</p>
        </div>`;
      return;
    }

    const rows = claims.map(c => `
      <tr>
        <td><code>[${escapeHtml(c.claimId)}]</code></td>
        <td>${escapeHtml(c.category)}</td>
        <td><span class="${c.status === 'VERIFIED' ? 'badge-verified' : 'badge-confirm'}">${escapeHtml(c.status)}</span></td>
        <td>${escapeHtml(c.text)}${c.metrics.length ? ` <span style="color:var(--text-muted);">(${escapeHtml(c.metrics.join(', '))})</span>` : ''}</td>
      </tr>
    `).join('');

    container.innerHTML = `
      ${syncContainer ? '' : syncHtml}
      <table class="matrix-table">
        <thead>
          <tr>
            <th>Claim</th>
            <th>Category</th>
            <th>Status</th>
            <th>Evidence Text</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  }

  function renderRunsTimeline(store) {
    const gridContainer = document.getElementById('agent-grid-container');
    const timelineContainer = document.getElementById('timeline-container');
    if (!gridContainer || !timelineContainer) return;

    const snapshot = store.state.snapshot || {};
    const charter = (snapshot.dashboard && Array.isArray(snapshot.dashboard.agentCharter) && snapshot.dashboard.agentCharter.length > 0)
      ? snapshot.dashboard.agentCharter
      : [
          { name: 'Dispatcher', role: 'State Waking', tier: 'Flash', mandate: 'Reads local state first and routes each request to a single owner.' },
          { name: 'Recon', role: 'Discovery & Triage', tier: 'Flash', mandate: 'Finds vacancies and scores fit without any penalty for posting age.' },
          { name: 'Scribe', role: 'CV & Cover Letter', tier: 'Pro', mandate: 'Drafts only from verified claims.' },
          { name: 'Inquisitor', role: 'Claim Verifier', tier: 'Pro+Script', mandate: 'Checks every cited claim against the dossier.' },
          { name: 'Critic', role: 'Blind Review Panel', tier: 'Pro', mandate: 'Reviews anonymized packs before they are marked ready.' },
          { name: 'Liaison', role: 'Signals & Cadence', tier: 'Flash', mandate: 'Tracks replies and follow-up timing; never sends outreach.' },
          { name: 'Navigator', role: 'Browser Sessions', tier: 'Flash', mandate: 'Prefills forms and stops at ready-to-submit for a human.' }
        ];
    const runsSummary = (store.state.runsData && store.state.runsData.agentRunsSummary) || {};

    gridContainer.innerHTML = charter.map(a => {
      const activity = runsSummary[`agent:${String(a.name).toLowerCase()}`] || runsSummary[a.name] || null;
      const statusLine = activity ? `${activity.eventCount} event(s)` : 'Charter';
      return `
      <div class="agent-card">
        <div style="flex:1;">
          <div style="display:flex; justify-content:space-between; align-items:center;">
            <strong>${escapeHtml(a.name)}</strong>
            <span style="font-size:0.7rem; color:var(--text-muted);">${escapeHtml(a.tier || '')}</span>
          </div>
          <div style="font-size:0.75rem; color:var(--text-secondary);">${escapeHtml(a.role || '')}</div>
          <div style="font-size:0.72rem; color:var(--text-secondary); margin-top:4px;">${escapeHtml(a.mandate || '')}</div>
          <div style="font-size:0.7rem; color:var(--color-success); font-weight:600; margin-top:4px;">${escapeHtml(statusLine)}</div>
        </div>
      </div>`;
    }).join('');

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
    document.querySelectorAll('.nav-pill, .nav-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        switchView(store, btn.getAttribute('data-view'));
      });
    });

    // Workbench application selector (options are re-rendered, so delegate)
    document.addEventListener('change', e => {
      if (e.target && e.target.id === 'workbench-app-selector') {
        store.setState({ selectedJobId: e.target.value });
      }
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

      // Approve outreach draft: copy the text for manual sending, then record
      // the approval. The crew never sends outreach itself.
      if (target.classList.contains('btn-approve-outreach')) {
        const jobId = target.getAttribute('data-job-id');
        const text = target.getAttribute('data-text') || '';
        const copyDone = () => {
          target.textContent = 'Copied — approval recorded';
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(copyDone).catch(() => {});
        } else {
          const helper = document.createElement('textarea');
          helper.value = text;
          document.body.appendChild(helper);
          helper.select();
          try { document.execCommand('copy'); copyDone(); } catch (_) {}
          document.body.removeChild(helper);
        }
        store.executeDecision({ type: 'approve_outreach', jobId, text }).catch(() => {});
      }

      // Jump from a ready pack straight into its workbench view
      if (target.classList.contains('btn-view-workbench')) {
        const jobId = target.getAttribute('data-job-id');
        store.setState({ selectedJobId: jobId });
        switchView(store, 'workbench');
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
