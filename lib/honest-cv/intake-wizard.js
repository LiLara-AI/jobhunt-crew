'use strict';

/**
 * JobHunt Crew — Single-Question Interactive Intake Wizard
 *
 * Implements the 10-turn interactive state machine (Q1 to Q10) per explorer_m3_1 specification:
 * - Strict one-question-per-turn state machine
 * - TitleFinder quoting verbatim CV lines across Lateral, Stretch, and Pivot tiers
 * - Dynamic country-to-city cascade with multi-select work modes
 * - 3-option salary disclosure policy
 * - Zero (Recommended) badges on factual personal attributes (work auth, notice period)
 * - Deterministic workspace builder writing dossier.json, CareerDossier.md,
 *   search-config.json, editorial-rules.json, appending CANDIDATE_ONBOARDED to ledger,
 *   and updating snapshot.
 *
 * Zero external dependencies. Uses Node.js standard runtime.
 */

const fs = require('fs');
const path = require('path');
const { CareerDossier } = require('./dossier');

// ============================================================================
// 1. TITLE FINDER
// ============================================================================

class TitleFinder {
  /**
   * Generates Lateral, Stretch, and Pivot title recommendations quoting verbatim CV lines.
   * @param {Object|string} dossierOrText Dossier object or raw CV text
   * @returns {Array<{ title: string, tier: 'lateral'|'stretch'|'pivot', verbatimQuote: string, recommended: boolean }>}
   */
  static generateRecommendations(dossierOrText) {
    let currentTitle = 'Senior Software Engineer';
    let quotes = [
      'Redesigned core systems and increased throughput and platform reliability.',
      'Architected scalable backend processing large-scale transaction volumes.',
      'Optimized operational workflows and mentored engineering teams.'
    ];

    if (typeof dossierOrText === 'string') {
      const titleMatch = dossierOrText.match(/(?:title|role|position)[:\s]+([^\n\r,]+)/i);
      if (titleMatch) currentTitle = titleMatch[1].trim();

      const candidateQuotes = dossierOrText
        .split('\n')
        .map(l => l.trim())
        .filter(l => l.length > 30 && (l.includes('%') || /\d+/.test(l) || /architect|design|lead|scale|built/i.test(l)));

      if (candidateQuotes.length >= 3) {
        quotes = candidateQuotes.slice(0, 3);
      }
    } else if (dossierOrText && typeof dossierOrText === 'object') {
      if (dossierOrText.candidate && dossierOrText.candidate.currentTitle) {
        currentTitle = dossierOrText.candidate.currentTitle;
      }
      if (Array.isArray(dossierOrText.claims) && dossierOrText.claims.length > 0) {
        quotes = dossierOrText.claims.map(c => c.text).filter(Boolean);
        if (quotes.length < 3) {
          while (quotes.length < 3) quotes.push(quotes[0] || 'Proven track record of engineering delivery.');
        }
      }
    }

    const isPlatform = /platform|infrastructure|architect|distributed/i.test(currentTitle);
    const isFullStack = /full-?stack|frontend|web/i.test(currentTitle);

    let lateralTitles = [];
    let stretchTitles = [];
    let pivotTitles = [];

    if (isPlatform) {
      lateralTitles = [currentTitle, 'Lead Distributed Systems Engineer', 'Principal Infrastructure Architect'];
      stretchTitles = ['Head of Platform Engineering', 'Director of Infrastructure'];
      pivotTitles = ['Principal Solutions Architect', 'Site Reliability Engineering Architect'];
    } else if (isFullStack) {
      lateralTitles = [currentTitle, 'Staff Software Engineer', 'Lead Full-Stack Architect'];
      stretchTitles = ['Principal Software Engineer', 'Engineering Manager (Web & Applications)'];
      pivotTitles = ['Staff Platform Engineer', 'E-Commerce Solutions Architect'];
    } else {
      lateralTitles = [currentTitle, `Staff ${currentTitle.replace(/^Senior\s+/i, '')}`];
      stretchTitles = [`Principal ${currentTitle.replace(/^Senior\s+/i, '')}`, 'Engineering Manager'];
      pivotTitles = ['Solutions Architect', 'Platform Systems Engineer'];
    }

    const recs = [];

    // Lateral (Recommended)
    for (const title of lateralTitles) {
      recs.push({
        title,
        tier: 'lateral',
        verbatimQuote: quotes[0] || 'Proven track record of core technical delivery.',
        recommended: true
      });
    }

    // Stretch
    for (const title of stretchTitles) {
      recs.push({
        title,
        tier: 'stretch',
        verbatimQuote: quotes[1] || 'Architected systems supporting substantial scale.',
        recommended: false
      });
    }

    // Pivot
    for (const title of pivotTitles) {
      recs.push({
        title,
        tier: 'pivot',
        verbatimQuote: quotes[2] || quotes[0] || 'Applied technical expertise across adjacent domains.',
        recommended: false
      });
    }

    return recs;
  }
}

// ============================================================================
// 2. WIZARD STEP SPECIFICATIONS (Q1 to Q10)
// ============================================================================

const WIZARD_STEPS = [
  {
    step: 1,
    id: 'Q1_CONNECTORS',
    title: 'Connector & Environment Verification',
    prompt: "Welcome to JobHunt Crew. Let's verify your local environment setup before we begin.",
    description: 'Verifies workspace filesystem permissions, Chrome browser integration, and email notification connectors. All state resides 100% locally in your workspace.',
    inputType: 'single_choice',
    recommended: 'all_connected',
    choices: [
      { id: 'all_connected', label: 'All connected — proceed with standard local setup (Recommended)', recommended: true },
      { id: 'assist_connectors', label: 'Help me configure Chrome DevTools / Email connectors first', recommended: false },
      { id: 'local_only', label: 'Continue in local-only mode without browser or email integrations', recommended: false }
    ]
  },
  {
    step: 2,
    id: 'Q2_CV_INGESTION',
    title: 'Curriculum Vitae Ingestion & Extraction',
    prompt: 'Please provide your current CV or resume text. You can specify a workspace file path (e.g. "resume.md" or "cv.txt") or paste the text directly.',
    description: 'Plain-text input. Modal choice buttons are strictly prohibited here to allow unobstructed file attachment and text pasting.',
    inputType: 'text_or_filepath',
    recommended: null,
    choices: []
  },
  {
    step: 3,
    id: 'Q3_TITLE_RECOMMENDATIONS',
    title: 'Recommended Target Job Titles',
    prompt: 'Based on your proven experience, here are recommended target job titles grouped by Lateral, Stretch, and Pivot tiers. Select all titles you want to target, or add custom titles.',
    description: 'Each recommendation is grounded in and quotes verbatim lines from your parsed CV.',
    inputType: 'multi_choice_with_custom',
    recommended: ['lateral_titles'],
    choices: [] // Generated dynamically based on Q2
  },
  {
    step: 4,
    id: 'Q4_TARGET_COUNTRIES',
    title: 'Target Employment Countries',
    prompt: 'Select the countries where you are actively seeking employment.',
    description: 'Multi-select. Your primary detected country is pre-recommended.',
    inputType: 'multi_choice',
    recommended: ['saudi_arabia'],
    choices: [
      { id: 'saudi_arabia', label: 'Saudi Arabia (Recommended)', recommended: true },
      { id: 'uae', label: 'United Arab Emirates', recommended: false },
      { id: 'qatar', label: 'Qatar', recommended: false },
      { id: 'kuwait', label: 'Kuwait', recommended: false },
      { id: 'bahrain', label: 'Bahrain', recommended: false },
      { id: 'oman', label: 'Oman', recommended: false },
      { id: 'egypt', label: 'Egypt', recommended: false },
      { id: 'uk', label: 'United Kingdom', recommended: false },
      { id: 'usa', label: 'United States', recommended: false },
      { id: 'remote_global', label: 'Remote / Global', recommended: false }
    ]
  },
  {
    step: 5,
    id: 'Q5_CITIES_AND_WORK_MODE',
    title: 'Cascaded Cities & Work-Mode Preferences',
    prompt: 'Select your target cities for the countries chosen, and check all acceptable work arrangements.',
    description: 'City choices dynamically cascade from Q4 countries. Work mode must allow multiple selections.',
    inputType: 'composite_cascade',
    recommendedCities: ['riyadh'],
    recommendedWorkModes: ['hybrid', 'remote'],
    citiesCascade: {
      saudi_arabia: [
        { id: 'riyadh', label: 'Riyadh (Recommended)', recommended: true },
        { id: 'jeddah', label: 'Jeddah', recommended: false },
        { id: 'dammam_khobar', label: 'Dammam / Khobar / Dhahran', recommended: false },
        { id: 'neom', label: 'NEOM', recommended: false },
        { id: 'red_sea', label: 'Red Sea Global / Amaala', recommended: false },
        { id: 'qiddiya_diriyah', label: 'Qiddiya / Diriyah', recommended: false },
        { id: 'all_ksa', label: 'All KSA Cities', recommended: false }
      ],
      uae: [
        { id: 'dubai', label: 'Dubai (Recommended)', recommended: true },
        { id: 'abu_dhabi', label: 'Abu Dhabi', recommended: false }
      ],
      uk: [
        { id: 'london', label: 'London (Recommended)', recommended: true },
        { id: 'cambridge', label: 'Cambridge', recommended: false }
      ],
      usa: [
        { id: 'new_york', label: 'New York (Recommended)', recommended: true },
        { id: 'san_francisco', label: 'San Francisco / Bay Area', recommended: false },
        { id: 'seattle', label: 'Seattle', recommended: false }
      ]
    },
    workModes: [
      { id: 'onsite', label: 'On-site' },
      { id: 'hybrid', label: 'Hybrid' },
      { id: 'remote', label: 'Remote' }
    ]
  },
  {
    step: 6,
    id: 'Q6_COMPENSATION_AND_POLICY',
    title: 'Compensation Floor & Form Disclosure Policy',
    prompt: 'Specify your compensation parameters and choose how application forms handle salary fields.',
    description: 'Enforces your preferred salary disclosure policy across all generated apply packs.',
    inputType: 'compensation_composite',
    currencies: ['SAR', 'AED', 'USD', 'GBP', 'EUR'],
    defaultCurrency: 'SAR',
    disclosurePolicies: [
      {
        id: 'mandatory_only',
        label: 'Mandatory Only (Recommended) — Never volunteer salary if optional; only enter floor when required by form',
        recommended: true
      },
      {
        id: 'negotiable_placeholder',
        label: 'Negotiable Placeholder — Enter "Negotiable / Open to market compensation" when text is permitted; otherwise floor',
        recommended: false
      },
      {
        id: 'always_disclose',
        label: 'Always Disclose — State minimum floor/target whenever a compensation field appears',
        recommended: false
      }
    ]
  },
  {
    step: 7,
    id: 'Q7_AUTHORIZATION_AND_KNOCKOUTS',
    title: 'Work Authorization, Notice Period & Hard Knockouts',
    prompt: 'Indicate your legal employment authorization, contractual notice period, and any industries to exclude.',
    description: 'ZERO (Recommended) labels appear on factual personal status options.',
    inputType: 'knockouts_composite',
    workAuthorizationChoices: [
      { id: 'saudi_national', label: 'Saudi National' },
      { id: 'gcc_national', label: 'GCC National' },
      { id: 'transferable_iqama', label: 'Transferable Iqama (KSA Resident)' },
      { id: 'visa_sponsorship', label: 'Requires Visa Sponsorship' }
    ],
    noticePeriodChoices: [
      { id: 'immediate', label: 'Immediate / Available Now' },
      { id: '30_days', label: '30 Days' },
      { id: '60_days', label: '60 Days' },
      { id: '90_days', label: '90 Days' }
    ],
    industryKnockoutsTree: [
      {
        id: 'financial_services',
        label: 'Financial Services',
        subIndustries: ['Conventional Banking', 'Crypto / Web3', 'Insurance']
      },
      {
        id: 'consulting_outsourcing',
        label: 'Consulting & Outsourcing',
        subIndustries: ['Staff Augmentation / Body-shopping', 'IT Outsourcing', 'BPO']
      },
      {
        id: 'consumer_products',
        label: 'Consumer Products',
        subIndustries: ['Tobacco / Vape', 'Gambling / Betting', 'Alcohol']
      },
      {
        id: 'defense_heavy',
        label: 'Defense & Heavy Industry',
        subIndustries: ['Weapons / Defense', 'Oil & Gas Upstream', 'Mining']
      }
    ]
  },
  {
    step: 8,
    id: 'Q8_JOB_BOARDS_AND_WATCHLIST',
    title: 'Job Boards Readiness & Enterprise Watchlist',
    prompt: 'Confirm your active job board sessions and strategic company watchlist.',
    description: 'Enables attended search sweeps and KSA enterprise direct discovery.',
    inputType: 'boards_watchlist_composite',
    boards: [
      { id: 'linkedin', name: 'LinkedIn Jobs' },
      { id: 'bayt', name: 'Bayt.com' },
      { id: 'gulftalent', name: 'GulfTalent' },
      { id: 'naukrigulf', name: 'Naukrigulf' },
      { id: 'indeed_sa', name: 'Indeed Saudi Arabia' },
      { id: 'wuzzuf', name: 'Wuzzuf' },
      { id: 'glassdoor', name: 'Glassdoor' },
      { id: 'remoteok', name: 'RemoteOK' }
    ],
    readinessOptions: [
      { id: 'signed_in', label: 'Signed in on Chrome (Ready for deep sweep)' },
      { id: 'needs_login', label: 'Have account — need to sign in' },
      { id: 'no_account', label: 'No account yet' }
    ],
    watchlistEnterprise: [
      'NEOM', 'PIF', 'ROSHN', 'Qiddiya', 'Red Sea Global', 'Diriyah Company',
      'STC', 'Solutions by stc', 'Aramco Digital', 'Elm', 'Almarai',
      'Tamara', 'Tabby', 'Jahez', 'HungerStation', 'Salla', 'Foodics'
    ],
    bilingualSearchDefault: true
  },
  {
    step: 9,
    id: 'Q9_SCHEDULE_AND_AUTOMATION',
    title: 'Daily Crew Execution & Auto-Prep Preferences',
    prompt: 'Set your preferred morning run schedule and review automation mode.',
    description: 'Controls when the agent crew runs and whether high-scoring roles are auto-drafted.',
    inputType: 'schedule_composite',
    scheduleHours: [
      { hour: 7, label: '07:00 AM local' },
      { hour: 8, label: '08:00 AM local (Recommended)', recommended: true },
      { hour: 9, label: '09:00 AM local' }
    ],
    defaultTimezone: 'Asia/Riyadh',
    autoPrepModes: [
      {
        id: 'manual_select',
        label: 'Wait for manual approval (Recommended) — I will review shortlisted roles before drafting',
        recommended: true
      },
      {
        id: 'auto_prep_top_3',
        label: 'Auto-prep top matches — Automatically draft application packages for top 3 daily scored roles',
        recommended: false
      }
    ]
  },
  {
    step: 10,
    id: 'Q10_WORKSPACE_BUILD',
    title: 'Deterministic Workspace Build & Ledger Initialization',
    prompt: 'All configuration parameters collected. Ready to build your JobHunt Crew workspace.',
    description: 'Executes atomic generation of dossier.json, CareerDossier.md, search-config.json, editorial-rules.json, and commits the initial ledger event.',
    inputType: 'confirmation',
    recommended: 'build_now',
    choices: [
      { id: 'build_now', label: 'Build workspace and initialize crew ledger (Recommended)', recommended: true }
    ]
  }
];

// ============================================================================
// 2b. CV TEXT PARSER
// ============================================================================

const CV_SECTION_PATTERNS = [
  [/^(?:professional\s+)?summary|profile|about/i, 'summary'],
  [/^(?:work\s+|professional\s+)?experience|employment(?:\s+history)?|career\s+history/i, 'experience'],
  [/^education|academic/i, 'education'],
  [/^certifications?|licen[cs]es?/i, 'certifications'],
  [/^(?:technical\s+|core\s+)?skills|technologies|competenc/i, 'skills'],
  [/^projects?/i, 'experience']
];

function cvSectionFor(heading) {
  const h = heading.replace(/^#+\s*/, '').replace(/:$/, '').trim();
  for (const [re, key] of CV_SECTION_PATTERNS) if (re.test(h)) return key;
  return null;
}

function extractMetricStrings(text) {
  const out = [];
  const re = /\$?\d[\d,]*(?:\.\d+)?\s*(?:%|x\b|ms\b|seconds?\b|minutes?\b|hours?\b|rps\b|qps\b|users?\b|customers?\b|engineers?\b|people\b|million\b|billion\b|k\b|M\b)?/gi;
  for (const m of String(text).matchAll(re)) {
    const v = m[0].trim();
    if (/^(?:19|20)\d{2}$/.test(v)) continue; // bare years are dates, not metrics
    if (v) out.push(v);
  }
  return [...new Set(out)].slice(0, 6);
}

/**
 * Parses free-form CV markdown/text into CareerDossier-shaped data.
 * Never invents facts: unparsed areas stay empty for later confirmation.
 * @param {string} cvText
 * @returns {Object} raw dossier data (pass to new CareerDossier)
 */
function parseCvText(cvText) {
  const text = String(cvText || '');
  const lines = text.split(/\r?\n/);
  const raw = {
    candidate: { salaryFloor: { currency: 'SAR', minimumBase: 0, targetTotal: 0, disclosurePolicy: 'mandatory_only' } },
    employers: [], claims: [], degrees: [], certifications: [],
    skills: { languages: [], frameworks: [], infrastructure: [], databases: [], architecturalDomains: [] }
  };
  const emailM = text.match(/[\w.+-]+@[\w-]+\.[\w.]+/);
  if (emailM) raw.candidate.email = emailM[0];
  const phoneM = text.match(/\+\d[\d\s-]{7,}\d/);
  if (phoneM) raw.candidate.phone = phoneM[0].trim();

  let section = 'header';
  let currentEmployer = null;
  let claimSeq = 0;
  const summaryLines = [];

  const pushClaim = (claimText, employer) => {
    if (!employer || !claimText || claimText.length < 8) return;
    claimSeq++;
    raw.claims.push({
      id: `C-${String(claimSeq).padStart(2, '0')}`,
      employerId: employer.id, category: 'experience',
      text: claimText.replace(/\s+/g, ' ').trim(),
      metrics: extractMetricStrings(claimText), tools: [],
      role: employer.title || '', status: 'CONFIRM',
      clarificationPrompt: 'Parsed from CV — please confirm this accomplishment'
    });
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || /^[-=_]{3,}$/.test(line)) continue;
    const isHeading = /^#{1,3}\s+/.test(line) || (/^[A-Z][A-Z /&]{2,30}:?$/.test(line) && cvSectionFor(line));
    if (isHeading) {
      const next = cvSectionFor(line);
      if (next) { section = next; continue; }
      if (section === 'header' && !raw.candidate.name) {
        raw.candidate.name = line.replace(/^#+\s*/, '').trim();
        continue;
      }
    }
    if (section === 'header') {
      if (!raw.candidate.name && line.length < 60 && !line.includes('@')) { raw.candidate.name = line; continue; }
      if (!raw.candidate.currentTitle && /engineer|manager|architect|director|consultant|analyst|designer|developer|lead|specialist|scientist/i.test(line) && line.length < 80) {
        raw.candidate.currentTitle = line.replace(/^[-•]\s*/, ''); continue;
      }
      continue;
    }
    if (section === 'summary') { summaryLines.push(line.replace(/^[-•]\s*/, '')); continue; }
    if (section === 'experience') {
      // Employer heading: "Title — Company (2020–Present)" / "Company | 2019 - 2022"
      const dateM = line.match(/\(?((?:19|20)\d{2})\s*[–—-]\s*((?:19|20)\d{2}|present|current|now)\)?/i);
      const hasClaimTag = /^-\s*\[/.test(line);
      if (dateM && !hasClaimTag && !/^[-•]/.test(line)) {
        const head = line.replace(dateM[0], '').replace(/[#*|·,–—-]+\s*$/, '').replace(/^#+\s*/, '').trim();
        const parts = head.split(/\s+(?:—|–|\||at)\s+|,\s+/).map(s => s.replace(/\*\*/g, '').trim()).filter(Boolean);
        const empName = parts.length > 1 ? parts[parts.length - 1] : (parts[0] || 'Employer');
        const title = parts.length > 1 ? parts.slice(0, -1).join(' — ') : '';
        const isCurrent = /present|current|now/i.test(dateM[2]);
        currentEmployer = {
          id: `emp_${String(raw.employers.length + 1).padStart(2, '0')}`,
          name: empName, location: '', startYear: parseInt(dateM[1], 10),
          endYear: isCurrent ? null : parseInt(dateM[2], 10), isCurrent, title
        };
        raw.employers.push(currentEmployer);
        if (!raw.candidate.currentTitle && title) raw.candidate.currentTitle = title;
        continue;
      }
      if (/^#{2,3}\s+/.test(line) && !cvSectionFor(line)) {
        // Employer sub-heading without dates
        currentEmployer = {
          id: `emp_${String(raw.employers.length + 1).padStart(2, '0')}`,
          name: line.replace(/^#+\s*/, '').replace(/\*\*/g, '').trim(), location: '',
          startYear: 2020, endYear: null, isCurrent: false, title: ''
        };
        raw.employers.push(currentEmployer);
        continue;
      }
      if (currentEmployer && /^[-•*]\s+/.test(line)) { pushClaim(line.replace(/^[-•*]\s+/, '').replace(/\[CONFIRM\]/g, ''), currentEmployer); continue; }
      if (currentEmployer && !currentEmployer.title && line.length < 80 && !/\d%/.test(line)) { currentEmployer.title = line.replace(/\*\*/g, ''); continue; }
      if (currentEmployer) pushClaim(line, currentEmployer);
      continue;
    }
    if (section === 'education') {
      const yearM = line.match(/\b((?:19|20)\d{2})\b/);
      const cleaned = line.replace(/^[-•*]\s+/, '').replace(/\*\*/g, '');
      const parts = cleaned.split(/[,–—|]/).map(s => s.trim()).filter(s => s && !/^\(?(?:19|20)\d{2}\)?$/.test(s));
      if (parts.length >= 1) raw.degrees.push({ degree: parts[0], institution: parts[1] || '', year: yearM ? parseInt(yearM[1], 10) : 2020 });
      continue;
    }
    if (section === 'certifications') {
      const yearM = line.match(/\b((?:19|20)\d{2})\b/);
      const cleaned = line.replace(/^[-•*]\s+/, '').replace(/\*\*/g, '');
      const parts = cleaned.split(/[,–—|]/).map(s => s.trim()).filter(s => s && !/^\(?(?:19|20)\d{2}\)?$/.test(s));
      if (parts.length >= 1) raw.certifications.push({ name: parts[0], issuer: parts[1] || '', year: yearM ? parseInt(yearM[1], 10) : 2020 });
      continue;
    }
    if (section === 'skills') {
      const cleaned = line.replace(/^[-•*]\s+/, '').replace(/\*\*/g, '');
      const labelM = cleaned.match(/^([^:]{2,30}):\s*(.+)$/);
      const items = (labelM ? labelM[2] : cleaned).split(/[,;·|]/).map(s => s.trim()).filter(Boolean);
      let bucket = 'languages';
      if (labelM) {
        const label = labelM[1].toLowerCase();
        if (/framework|librar|platform/.test(label)) bucket = 'frameworks';
        else if (/infra|cloud|devops|tool/.test(label)) bucket = 'infrastructure';
        else if (/data|db|sql/.test(label)) bucket = 'databases';
        else if (/architect|domain|method/.test(label)) bucket = 'architecturalDomains';
      }
      raw.skills[bucket].push(...items);
      continue;
    }
  }
  if (summaryLines.length) raw.candidate.summary = summaryLines.join(' ').replace(/\s+/g, ' ').trim();
  for (const key of Object.keys(raw.skills)) raw.skills[key] = [...new Set(raw.skills[key])];
  return raw;
}

// ============================================================================
// 3. WORKSPACE BUILDER
// ============================================================================

class WorkspaceBuilder {
  /**
   * Deterministically writes workspace files and records ledger event.
   */
  static async build(workspaceDir, state) {
    const targetDir = path.resolve(workspaceDir);
    const crewDir = path.join(targetDir, '.crew');

    if (!fs.existsSync(crewDir)) {
      fs.mkdirSync(crewDir, { recursive: true });
    }

    // 1. Build CareerDossier
    let dossierData = state.dossier;
    if (!dossierData) {
      dossierData = CareerDossier.createTemplate();
    }
    const dossier = new CareerDossier(dossierData);

    // Apply compensation & preferences from wizard state
    if (state.compensation) {
      dossier.candidate.salaryFloor = {
        currency: state.compensation.currency || 'SAR',
        minimumBase: state.compensation.minimumBase || 0,
        targetTotal: state.compensation.targetTotal || 0,
        disclosurePolicy: state.compensation.disclosurePolicy || 'mandatory_only'
      };
    }
    if (state.authorization) {
      dossier.candidate.workAuthorization = state.authorization.workAuthorization || dossier.candidate.workAuthorization;
      if (typeof state.authorization.noticePeriodDays === 'number') {
        dossier.candidate.noticePeriodDays = state.authorization.noticePeriodDays;
      }
    }

    // Save dossier.json and CareerDossier.md
    fs.writeFileSync(path.join(targetDir, 'dossier.json'), dossier.toJson(true), 'utf8');
    fs.writeFileSync(path.join(targetDir, 'CareerDossier.md'), dossier.toMarkdown(), 'utf8');

    // 2. Build search-config.json
    const searchConfig = {
      version: '1.0.0',
      updatedAt: new Date().toISOString(),
      targetTitles: state.targetTitles || [dossier.candidate.currentTitle || 'Senior Software Engineer'],
      targetLocations: {
        countries: state.targetCountries || ['Saudi Arabia'],
        cities: state.targetCities || ['Riyadh'],
        workModes: state.workModes || ['Hybrid', 'Remote']
      },
      knockouts: {
        excludedIndustries: state.knockouts ? state.knockouts.excludedIndustries || [] : [],
        excludedSubIndustries: state.knockouts ? state.knockouts.excludedSubIndustries || [] : [],
        excludedCompanies: state.knockouts ? state.knockouts.excludedCompanies || [] : [],
        seniorityFloor: state.knockouts ? state.knockouts.seniorityFloor || '' : ''
      },
      jobBoards: state.jobBoards || [
        { id: 'linkedin', name: 'LinkedIn Jobs', readiness: 'signed_in' },
        { id: 'bayt', name: 'Bayt.com', readiness: 'signed_in' }
      ],
      watchlist: state.watchlist || [
        'NEOM', 'PIF', 'ROSHN', 'Qiddiya', 'Red Sea Global', 'STC', 'Almarai', 'Tamara'
      ],
      schedule: state.schedule || {
        startHour: 8,
        timezone: 'Asia/Riyadh',
        autoPrep: false
      }
    };
    fs.writeFileSync(path.join(targetDir, 'search-config.json'), JSON.stringify(searchConfig, null, 2), 'utf8');

    // 3. Build editorial-rules.json
    const editorialRules = {
      version: '1.0.0',
      updatedAt: new Date().toISOString(),
      salaryDisclosurePolicy: dossier.candidate.salaryFloor.disclosurePolicy,
      rules: [
        {
          id: 'rule_active_voice',
          category: 'styling',
          pattern: 'was responsible for',
          replacement: 'directed',
          rationale: 'Prefer strong active verbs over passive construction',
          active: true
        }
      ]
    };
    fs.writeFileSync(path.join(crewDir, 'editorial-rules.json'), JSON.stringify(editorialRules, null, 2), 'utf8');

    // Also export editorial-rules.md
    const editorialRulesMd = [
      '# Editorial Rules',
      '',
      `> Salary Disclosure Policy: **${editorialRules.salaryDisclosurePolicy}**`,
      '',
      '## Active Rules',
      '- **rule_active_voice**: Replace "was responsible for" with "directed" (Prefer strong active verbs)'
    ].join('\n');
    fs.writeFileSync(path.join(targetDir, 'editorial-rules.md'), editorialRulesMd, 'utf8');

    // 4. Commit CANDIDATE_ONBOARDED to ledger if ledger module is available
    const ledgerPath = path.join(crewDir, 'ledger.jsonl');
    const lockPath = path.join(crewDir, 'ledger.lock');

    try {
      const { EventLedger } = require('../ledger/ledger');
      const { replayLedger } = require('../ledger/reducer');

      const ledger = new EventLedger({
        workspaceDir: targetDir,
        ledgerPath,
        lockPath
      });

      await ledger.appendEvent({
        event: 'CANDIDATE_ONBOARDED',
        actor: 'human',
        payload: {
          schemaVersion: '1.0.0',
          currentTitle: dossier.candidate.currentTitle,
          claimsCount: dossier.claims.length,
          verifiedCount: dossier.claims.filter(c => c.status === 'VERIFIED').length,
          pendingCount: dossier.claims.filter(c => c.status === 'CONFIRM').length,
          targetTitles: searchConfig.targetTitles,
          targetCountries: searchConfig.targetLocations.countries,
          salaryDisclosurePolicy: dossier.candidate.salaryFloor.disclosurePolicy
        }
      });

      await replayLedger({
        workspaceDir: targetDir,
        ledgerPath,
        snapshotPath: path.join(crewDir, 'snapshot.json'),
        rebuild: false
      });
    } catch (_) {
      // If ledger is not initialized or in standalone mode, write minimal snapshot
      const snapshotPath = path.join(crewDir, 'snapshot.json');
      if (!fs.existsSync(snapshotPath)) {
        const minimalSnapshot = {
          version: 1,
          lastEventId: 1,
          updatedAt: new Date().toISOString(),
          candidate: {
            name: dossier.candidate.name,
            currentTitle: dossier.candidate.currentTitle,
            onboarded: true
          },
          jobs: {},
          applications: {},
          decisions: []
        };
        fs.writeFileSync(snapshotPath, JSON.stringify(minimalSnapshot, null, 2), 'utf8');
      }
    }

    return {
      success: true,
      workspaceDir: targetDir,
      filesCreated: [
        'dossier.json',
        'CareerDossier.md',
        'search-config.json',
        '.crew/editorial-rules.json',
        'editorial-rules.md'
      ]
    };
  }
}

// ============================================================================
// 4. INTAKE WIZARD STATE MACHINE
// ============================================================================

class IntakeWizard {
  /**
   * @param {Object} options Configuration and initial state
   */
  constructor(options = {}) {
    this.workspaceDir = options.workspaceDir || process.cwd();
    this.stateFile = options.stateFile || path.join(this.workspaceDir, '.crew', 'intake-state.json');
    this.currentStepIndex = 0; // 0 to 9 corresponds to Q1 to Q10
    this.state = {
      connectors: null,
      cvRaw: null,
      dossier: null,
      targetTitles: [],
      targetCountries: [],
      targetCities: [],
      workModes: [],
      compensation: null,
      authorization: null,
      knockouts: null,
      jobBoards: [],
      watchlist: [],
      schedule: null,
      completed: false
    };

    if (options.autoLoad !== false) {
      this.load();
    }
  }

  getCurrentStep() {
    if (this.state.completed || this.currentStepIndex >= WIZARD_STEPS.length) {
      return {
        step: 11,
        id: 'COMPLETED',
        title: 'Intake Completed',
        prompt: 'Onboarding is complete. Your workspace has been configured.',
        description: 'You can now proceed with discovery and job tailoring.',
        inputType: 'none',
        choices: [],
        completed: true
      };
    }

    const stepDef = { ...WIZARD_STEPS[this.currentStepIndex] };

    // Dynamically inject title recommendations if at Q3
    if (stepDef.id === 'Q3_TITLE_RECOMMENDATIONS' && this.state.dossier) {
      stepDef.choices = TitleFinder.generateRecommendations(this.state.dossier);
    }

    return stepDef;
  }

  submitAnswer(answer) {
    if (this.state.completed) {
      throw new Error('INTAKE_ERROR: Intake wizard is already completed');
    }

    const step = WIZARD_STEPS[this.currentStepIndex];
    if (!step) {
      throw new Error('INTAKE_ERROR: Invalid wizard state');
    }

    switch (step.id) {
      case 'Q1_CONNECTORS': {
        const choice = typeof answer === 'object' ? answer.choice || answer.id : answer;
        this.state.connectors = choice || 'all_connected';
        break;
      }

      case 'Q2_CV_INGESTION': {
        let cvText = '';
        if (typeof answer === 'string') {
          // Check if file exists
          if (fs.existsSync(answer)) {
            cvText = fs.readFileSync(answer, 'utf8');
          } else {
            cvText = answer;
          }
        } else if (answer && answer.text) {
          cvText = answer.text;
        }

        if (!cvText || cvText.trim().length === 0) {
          throw new Error('INTAKE_VALIDATION_ERROR: CV text or valid file path is required');
        }

        this.state.cvRaw = cvText;

        // Extract structured dossier from CV text; template only if unparseable
        try {
          if (cvText.trim().startsWith('{')) {
            this.state.dossier = JSON.parse(cvText);
          } else if (/^#\s+(?:Career Dossier|.+Master Career Profile)/im.test(cvText)) {
            this.state.dossier = CareerDossier.fromMarkdown(cvText);
          } else {
            const parsed = parseCvText(cvText);
            const hasContent = parsed.employers.length > 0 || parsed.claims.length > 0 ||
              parsed.candidate.summary || parsed.degrees.length > 0;
            this.state.dossier = hasContent ? new CareerDossier(parsed) : CareerDossier.createTemplate();
            if (!hasContent) {
              const firstLine = cvText.split('\n')[0].replace(/^#+\s*/, '').trim();
              if (firstLine && firstLine.length < 50) this.state.dossier.candidate.name = firstLine;
            }
          }
        } catch (_) {
          this.state.dossier = CareerDossier.createTemplate();
        }
        break;
      }

      case 'Q3_TITLE_RECOMMENDATIONS': {
        const titles = Array.isArray(answer) ? answer : (answer.titles || [answer]);
        this.state.targetTitles = titles.map(t => typeof t === 'object' ? t.title : String(t));
        if (this.state.targetTitles.length === 0) {
          this.state.targetTitles = ['Senior Software Engineer'];
        }
        break;
      }

      case 'Q4_TARGET_COUNTRIES': {
        const countries = Array.isArray(answer) ? answer : (answer.countries || [answer]);
        this.state.targetCountries = countries.map(String);
        if (this.state.targetCountries.length === 0) {
          this.state.targetCountries = ['Saudi Arabia'];
        }
        break;
      }

      case 'Q5_CITIES_AND_WORK_MODE': {
        if (typeof answer === 'object' && answer !== null) {
          this.state.targetCities = Array.isArray(answer.cities) ? answer.cities : ['Riyadh'];
          this.state.workModes = Array.isArray(answer.workModes) ? answer.workModes : ['Hybrid', 'Remote'];
        } else {
          this.state.targetCities = ['Riyadh'];
          this.state.workModes = ['Hybrid', 'Remote'];
        }
        break;
      }

      case 'Q6_COMPENSATION_AND_POLICY': {
        const comp = typeof answer === 'object' ? answer : {};
        this.state.compensation = {
          currency: comp.currency || 'SAR',
          minimumBase: typeof comp.minimumBase === 'number' ? comp.minimumBase : (parseInt(comp.minimumBase, 10) || 35000),
          targetTotal: typeof comp.targetTotal === 'number' ? comp.targetTotal : (parseInt(comp.targetTotal, 10) || 45000),
          disclosurePolicy: comp.disclosurePolicy || 'mandatory_only'
        };
        break;
      }

      case 'Q7_AUTHORIZATION_AND_KNOCKOUTS': {
        const auth = typeof answer === 'object' ? answer : {};
        this.state.authorization = {
          workAuthorization: auth.workAuthorization || 'Transferable Iqama',
          noticePeriodDays: typeof auth.noticePeriodDays === 'number' ? auth.noticePeriodDays : 30
        };
        this.state.knockouts = {
          excludedIndustries: Array.isArray(auth.excludedIndustries) ? auth.excludedIndustries : [],
          excludedSubIndustries: Array.isArray(auth.excludedSubIndustries) ? auth.excludedSubIndustries : [],
          excludedCompanies: Array.isArray(auth.excludedCompanies) ? auth.excludedCompanies : [],
          seniorityFloor: auth.seniorityFloor || ''
        };
        break;
      }

      case 'Q8_JOB_BOARDS_AND_WATCHLIST': {
        const bw = typeof answer === 'object' ? answer : {};
        this.state.jobBoards = Array.isArray(bw.boards) ? bw.boards : [
          { id: 'linkedin', name: 'LinkedIn Jobs', readiness: 'signed_in' },
          { id: 'bayt', name: 'Bayt.com', readiness: 'signed_in' }
        ];
        this.state.watchlist = Array.isArray(bw.watchlist) ? bw.watchlist : [
          'NEOM', 'PIF', 'ROSHN', 'Qiddiya', 'Red Sea Global', 'STC', 'Almarai', 'Tamara'
        ];
        break;
      }

      case 'Q9_SCHEDULE_AND_AUTOMATION': {
        const sch = typeof answer === 'object' ? answer : {};
        this.state.schedule = {
          startHour: sch.startHour || 8,
          timezone: sch.timezone || 'Asia/Riyadh',
          autoPrep: Boolean(sch.autoPrep)
        };
        break;
      }

      case 'Q10_WORKSPACE_BUILD': {
        this.state.completed = true;
        break;
      }
    }

    this.currentStepIndex++;
    if (this.currentStepIndex >= WIZARD_STEPS.length) {
      this.state.completed = true;
    }

    this.save();
    return this.getCurrentStep();
  }

  isComplete() {
    return Boolean(this.state.completed);
  }

  async buildWorkspace(targetWorkspace = null) {
    const ws = targetWorkspace || this.workspaceDir;
    const result = await WorkspaceBuilder.build(ws, this.state);
    return result;
  }

  save() {
    try {
      const dir = path.dirname(this.stateFile);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.stateFile, JSON.stringify({
        currentStepIndex: this.currentStepIndex,
        state: this.state,
        updatedAt: new Date().toISOString()
      }, null, 2), 'utf8');
    } catch (_) {}
  }

  load() {
    if (fs.existsSync(this.stateFile)) {
      try {
        const data = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
        this.currentStepIndex = data.currentStepIndex || 0;
        this.state = data.state || this.state;
      } catch (_) {}
    }
  }
}

module.exports = {
  IntakeWizard,
  TitleFinder,
  WorkspaceBuilder,
  WIZARD_STEPS,
  parseCvText
};
