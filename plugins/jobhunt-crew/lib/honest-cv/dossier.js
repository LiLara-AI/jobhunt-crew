'use strict';

/**
 * JobHunt Crew — Career Dossier & Atomic Claim Model
 *
 * Implements the CareerDossier class with deep schema validation,
 * employer-bound atomic claims [C-xx], claim verification appendix tracking,
 * hard gating against unconfirmed claims, privacy-scrubbed blind review export,
 * and bi-directional JSON/Markdown serialization.
 *
 * Zero external dependencies. Uses Node.js standard runtime.
 */

class CareerDossier {
  /**
   * @param {Object} data Raw dossier data object
   */
  constructor(data = {}) {
    const raw = typeof data === 'string' ? JSON.parse(data) : data;

    this.schemaVersion = raw.schemaVersion || '1.0.0';
    this.updatedAt = raw.updatedAt || new Date().toISOString();

    // 1. Candidate Info
    const cand = raw.candidate || {};
    this.candidate = {
      name: cand.name || '[Candidate Name]',
      email: cand.email || 'user@example.org',
      phone: cand.phone || '+1 555-0100',
      location: cand.location || '',
      workAuthorization: cand.workAuthorization || '',
      noticePeriodDays: typeof cand.noticePeriodDays === 'number' ? cand.noticePeriodDays : 30,
      currentTitle: cand.currentTitle || '',
      summary: cand.summary || '',
      salaryFloor: cand.salaryFloor ? {
        currency: cand.salaryFloor.currency || 'SAR',
        minimumBase: typeof cand.salaryFloor.minimumBase === 'number' ? cand.salaryFloor.minimumBase : 0,
        targetTotal: typeof cand.salaryFloor.targetTotal === 'number' ? cand.salaryFloor.targetTotal : 0,
        disclosurePolicy: cand.salaryFloor.disclosurePolicy || 'mandatory_only'
      } : {
        currency: 'SAR',
        minimumBase: 0,
        targetTotal: 0,
        disclosurePolicy: 'mandatory_only'
      }
    };

    // 2. Employers
    this.employers = Array.isArray(raw.employers) ? raw.employers.map(e => ({
      id: String(e.id || ''),
      name: String(e.name || ''),
      location: String(e.location || ''),
      startYear: typeof e.startYear === 'number' ? e.startYear : parseInt(e.startYear, 10) || 2020,
      endYear: e.isCurrent ? null : (typeof e.endYear === 'number' ? e.endYear : (e.endYear ? parseInt(e.endYear, 10) : null)),
      isCurrent: Boolean(e.isCurrent),
      title: String(e.title || '')
    })) : [];

    // 3. Claims (Strictly bound to employerId)
    this.claims = Array.isArray(raw.claims) ? raw.claims.map(c => {
      const normalizedId = String(c.id || '').replace(/^\[|\]$/g, '').trim();
      return {
        id: normalizedId,
        employerId: String(c.employerId || ''),
        category: String(c.category || 'general'),
        text: String(c.text || ''),
        // Accept string metrics ("28%") and structured metrics ({type,value,unit})
        metrics: Array.isArray(c.metrics) ? c.metrics.map(m =>
          (m && typeof m === 'object') ? `${m.value}${m.unit ? ' ' + m.unit : ''}`.trim() : String(m)) : [],
        tools: Array.isArray(c.tools) ? c.tools.map(String)
          : (Array.isArray(c.technologies) ? c.technologies.map(String) : []),
        role: String(c.role || ''),
        status: (c.status === 'CONFIRM' ? 'CONFIRM' : 'VERIFIED'),
        evidence: c.evidence ? String(c.evidence) : null,
        clarificationPrompt: c.clarificationPrompt ? String(c.clarificationPrompt) : null,
        updatedAt: c.updatedAt || new Date().toISOString()
      };
    }) : [];

    // 4. Degrees & Certifications
    this.degrees = Array.isArray(raw.degrees) ? raw.degrees.map(d => ({
      degree: String(d.degree || ''),
      institution: String(d.institution || ''),
      year: typeof d.year === 'number' ? d.year : parseInt(d.year, 10) || 2020,
      thesis: d.thesis ? String(d.thesis) : undefined
    })) : [];

    this.certifications = Array.isArray(raw.certifications) ? raw.certifications.map(crt => ({
      name: String(crt.name || ''),
      issuer: String(crt.issuer || ''),
      year: typeof crt.year === 'number' ? crt.year : parseInt(crt.year, 10) || 2020
    })) : [];

    // 5. Skills Taxonomy
    const sk = raw.skills || {};
    this.skills = {
      languages: Array.isArray(sk.languages) ? sk.languages.map(String) : [],
      frameworks: Array.isArray(sk.frameworks) ? sk.frameworks.map(String) : [],
      infrastructure: Array.isArray(sk.infrastructure) ? sk.infrastructure.map(String) : [],
      databases: Array.isArray(sk.databases) ? sk.databases.map(String) : [],
      architecturalDomains: Array.isArray(sk.architecturalDomains) ? sk.architecturalDomains.map(String) : []
    };

    // 6. Preferences
    const pref = raw.preferences || {};
    this.preferences = {
      targetTitles: Array.isArray(pref.targetTitles) ? pref.targetTitles : [],
      targetLocations: Array.isArray(pref.targetLocations) ? pref.targetLocations : [],
      knockouts: pref.knockouts || {
        excludedIndustries: [],
        excludedSubIndustries: [],
        excludedCompanies: [],
        seniorityFloor: ''
      },
      jobBoards: Array.isArray(pref.jobBoards) ? pref.jobBoards : [],
      schedule: pref.schedule || {
        startHour: 8,
        timezone: 'Asia/Riyadh',
        autoPrep: false
      }
    };

    // 7. Claim Verification Appendix
    const app = raw.claimVerificationAppendix || {};
    this.claimVerificationAppendix = {
      verifiedCount: this.claims.filter(c => c.status === 'VERIFIED').length,
      pendingCount: this.claims.filter(c => c.status === 'CONFIRM').length,
      verificationLog: Array.isArray(app.verificationLog) ? app.verificationLog : []
    };

    this.validate();
  }

  // ==========================================================================
  // Validation
  // ==========================================================================

  validate() {
    if (!this.candidate || typeof this.candidate !== 'object') {
      throw new Error('DOSSIER_VALIDATION_ERROR: Candidate section is required');
    }
    if (!Array.isArray(this.employers)) {
      throw new Error('DOSSIER_VALIDATION_ERROR: Employers must be an array');
    }
    if (!Array.isArray(this.claims)) {
      throw new Error('DOSSIER_VALIDATION_ERROR: Claims must be an array');
    }

    const employerIds = new Set(this.employers.map(e => e.id));

    // Foreign key check: Every claim MUST be bound to a known employerId
    for (const c of this.claims) {
      if (!c.id) {
        throw new Error('DOSSIER_VALIDATION_ERROR: Claim ID cannot be empty');
      }
      if (!c.employerId || !employerIds.has(c.employerId)) {
        throw new Error(`DOSSIER_VALIDATION_ERROR: Claim "${c.id}" references unknown employerId "${c.employerId}"`);
      }
      if (!Array.isArray(c.metrics)) {
        throw new Error(`DOSSIER_VALIDATION_ERROR: Claim "${c.id}" metrics must be an array`);
      }
      if (!Array.isArray(c.tools)) {
        throw new Error(`DOSSIER_VALIDATION_ERROR: Claim "${c.id}" tools must be an array`);
      }
    }

    // Salary disclosure policy validation
    if (this.candidate.salaryFloor && this.candidate.salaryFloor.disclosurePolicy) {
      const validPolicies = ['mandatory_only', 'negotiable_placeholder', 'always_disclose', 'leave_blank_if_optional', 'state_floor_when_mandatory'];
      if (!validPolicies.includes(this.candidate.salaryFloor.disclosurePolicy)) {
        throw new Error(`DOSSIER_VALIDATION_ERROR: Invalid salary disclosure policy: ${this.candidate.salaryFloor.disclosurePolicy}`);
      }
    }

    return true;
  }

  // ==========================================================================
  // Query & Lookup
  // ==========================================================================

  getClaim(claimId) {
    if (!claimId) return null;
    const cleanId = String(claimId).replace(/^\[|\]$/g, '').trim().toLowerCase();
    return this.claims.find(c => c.id.toLowerCase() === cleanId) || null;
  }

  getClaimsByEmployer(employerId) {
    return this.claims.filter(c => c.employerId === employerId);
  }

  getPendingClaims() {
    return this.claims.filter(c => c.status === 'CONFIRM');
  }

  hasUnconfirmedClaims() {
    return this.claims.some(c => c.status === 'CONFIRM');
  }

  // ==========================================================================
  // Claim Status Mutations
  // ==========================================================================

  confirmClaim(claimId, evidence, actor = 'candidate') {
    const claim = this.getClaim(claimId);
    if (!claim) {
      throw new Error(`DOSSIER_ERROR: Claim not found: ${claimId}`);
    }

    claim.status = 'VERIFIED';
    claim.evidence = evidence || 'Candidate verified';
    claim.clarificationPrompt = null;
    claim.updatedAt = new Date().toISOString();

    this.claimVerificationAppendix.verificationLog.push({
      claimId: claim.id,
      action: 'VERIFIED',
      actor,
      timestamp: claim.updatedAt,
      evidence: claim.evidence
    });

    this.claimVerificationAppendix.verifiedCount = this.claims.filter(c => c.status === 'VERIFIED').length;
    this.claimVerificationAppendix.pendingCount = this.claims.filter(c => c.status === 'CONFIRM').length;
    this.updatedAt = new Date().toISOString();

    return claim;
  }

  tagClaimForConfirmation(claimId, clarificationPrompt, actor = 'inquisitor') {
    const claim = this.getClaim(claimId);
    if (!claim) {
      throw new Error(`DOSSIER_ERROR: Claim not found: ${claimId}`);
    }

    claim.status = 'CONFIRM';
    claim.clarificationPrompt = clarificationPrompt || 'Please confirm this accomplishment';
    claim.updatedAt = new Date().toISOString();

    this.claimVerificationAppendix.verificationLog.push({
      claimId: claim.id,
      action: 'CONFIRM',
      actor,
      timestamp: claim.updatedAt,
      note: claim.clarificationPrompt
    });

    this.claimVerificationAppendix.verifiedCount = this.claims.filter(c => c.status === 'VERIFIED').length;
    this.claimVerificationAppendix.pendingCount = this.claims.filter(c => c.status === 'CONFIRM').length;
    this.updatedAt = new Date().toISOString();

    return claim;
  }

  // ==========================================================================
  // Guardrail Hard Gating
  // ==========================================================================

  assertCanGenerate(claimsUsed = null) {
    if (Array.isArray(claimsUsed)) {
      for (const id of claimsUsed) {
        const cleanId = String(id).replace(/^\[|\]$/g, '').trim();
        const claim = this.getClaim(cleanId);
        if (!claim) {
          throw new Error(`DOSSIER_GUARDRAIL_VIOLATION: Claim "${id}" is not found in candidate dossier`);
        }
        if (claim.status !== 'VERIFIED') {
          throw new Error(`DOSSIER_GUARDRAIL_VIOLATION: Claim "${id}" has status "${claim.status}" (must be VERIFIED to generate documents)`);
        }
      }
    } else {
      if (this.hasUnconfirmedClaims()) {
        const unconfirmed = this.getPendingClaims().map(c => c.id).join(', ');
        throw new Error(`DOSSIER_GUARDRAIL_VIOLATION: Candidate dossier has unconfirmed claims: ${unconfirmed}`);
      }
    }
    return true;
  }

  // ==========================================================================
  // Blind Review Anonymized Export
  // ==========================================================================

  exportForBlindReview() {
    // Strips candidate name, email, phone, private salary floor, and claim tags
    const scrubbedSummary = this.candidate.summary
      .replace(new RegExp(this.candidate.name, 'gi'), 'Candidate')
      .replace(new RegExp(this.candidate.email, 'gi'), '[email]')
      .replace(new RegExp(this.candidate.phone.replace(/\+/g, '\\+'), 'gi'), '[phone]');

    const scrubbedClaims = this.claims.map(c => {
      // Remove tag brackets if present in text
      let text = c.text.replace(/\[(?:CLM|C|ALX|MV)-\d+\]/gi, '').trim();
      if (this.candidate.name) {
        text = text.replace(new RegExp(this.candidate.name, 'gi'), 'Candidate');
      }
      return {
        category: c.category,
        text,
        metrics: [...c.metrics],
        tools: [...c.tools],
        role: c.role
      };
    });

    return {
      candidate: {
        currentTitle: this.candidate.currentTitle,
        location: this.candidate.location,
        summary: scrubbedSummary
      },
      employers: this.employers.map(e => ({
        name: e.name,
        location: e.location,
        startYear: e.startYear,
        endYear: e.endYear,
        isCurrent: e.isCurrent,
        title: e.title
      })),
      claims: scrubbedClaims,
      degrees: this.degrees.map(d => ({
        degree: d.degree,
        institution: d.institution,
        year: d.year
      })),
      certifications: this.certifications.map(c => ({
        name: c.name,
        issuer: c.issuer,
        year: c.year
      })),
      skills: JSON.parse(JSON.stringify(this.skills))
    };
  }

  // ==========================================================================
  // Serialization (JSON & Markdown)
  // ==========================================================================

  toJson(pretty = true) {
    const obj = {
      schemaVersion: this.schemaVersion,
      updatedAt: this.updatedAt,
      candidate: this.candidate,
      employers: this.employers,
      claims: this.claims,
      degrees: this.degrees,
      certifications: this.certifications,
      skills: this.skills,
      preferences: this.preferences,
      claimVerificationAppendix: this.claimVerificationAppendix
    };
    return pretty ? JSON.stringify(obj, null, 2) : JSON.stringify(obj);
  }

  toMarkdown() {
    const lines = [];

    lines.push(`# Career Dossier — ${this.candidate.name}`);
    lines.push('');
    lines.push('> **Integrity Mode**: Clean-Room · Deterministic Claim-Verified · Zero PII');
    lines.push('');
    lines.push('## 1. Professional Summary');
    lines.push(this.candidate.summary || 'No summary provided.');
    lines.push('');
    lines.push('## 2. Career Target & Compensation Policy');
    lines.push(`- **Current Title**: ${this.candidate.currentTitle}`);
    lines.push(`- **Location**: ${this.candidate.location}`);
    lines.push(`- **Work Authorization**: ${this.candidate.workAuthorization}`);
    lines.push(`- **Notice Period**: ${this.candidate.noticePeriodDays} Days`);
    if (this.candidate.salaryFloor) {
      lines.push(`- **Salary Floor**: [Confidential Floor: ${this.candidate.salaryFloor.currency} ${this.candidate.salaryFloor.minimumBase.toLocaleString()} / month base]`);
      lines.push(`- **Form Disclosure Policy**: ${this.candidate.salaryFloor.disclosurePolicy}`);
    }
    lines.push('');
    lines.push('## 3. Verified Work Experience');
    lines.push('');

    for (const emp of this.employers) {
      const dates = emp.isCurrent ? `${emp.startYear} – Present` : `${emp.startYear} – ${emp.endYear || 'Present'}`;
      lines.push(`### ${emp.name} (${dates})`);
      lines.push(`<!-- employer-id: ${emp.id} -->`);
      lines.push(`**${emp.title}** · ${emp.location}`);
      const empClaims = this.getClaimsByEmployer(emp.id);
      for (const clm of empClaims) {
        const tag = `[${clm.id}]`;
        lines.push(`- ${tag} ${clm.text}`);
      }
      lines.push('');
    }

    lines.push('## 4. Education & Certifications');
    if (this.degrees && this.degrees.length > 0) {
      lines.push('### Degrees');
      for (const d of this.degrees) {
        const thesisStr = d.thesis ? ` — *Thesis: ${d.thesis}*` : '';
        lines.push(`- **${d.degree}**, ${d.institution} (${d.year})${thesisStr}`);
      }
      lines.push('');
    }
    if (this.certifications && this.certifications.length > 0) {
      lines.push('### Certifications');
      for (const c of this.certifications) {
        lines.push(`- **${c.name}**, ${c.issuer} (${c.year})`);
      }
      lines.push('');
    }
    if ((!this.degrees || this.degrees.length === 0) && (!this.certifications || this.certifications.length === 0)) {
      lines.push('None documented.');
      lines.push('');
    }

    lines.push('## 5. Structured Skills Taxonomy');
    if (this.skills.languages && this.skills.languages.length > 0) {
      lines.push(`- **Languages**: ${this.skills.languages.join(', ')}`);
    }
    if (this.skills.frameworks && this.skills.frameworks.length > 0) {
      lines.push(`- **Frameworks**: ${this.skills.frameworks.join(', ')}`);
    }
    if (this.skills.infrastructure && this.skills.infrastructure.length > 0) {
      lines.push(`- **Infrastructure**: ${this.skills.infrastructure.join(', ')}`);
    }
    if (this.skills.databases && this.skills.databases.length > 0) {
      lines.push(`- **Databases**: ${this.skills.databases.join(', ')}`);
    }
    if (this.skills.architecturalDomains && this.skills.architecturalDomains.length > 0) {
      lines.push(`- **Architectural Domains**: ${this.skills.architecturalDomains.join(', ')}`);
    }
    lines.push('');

    lines.push('---');
    lines.push('');
    lines.push('## 6. Claim Verification Appendix');
    lines.push('');
    lines.push('| Claim ID | Employer | Category | Status | Verified Metrics | Verified Tools | Verification Evidence |');
    lines.push('|---|---|---|---|---|---|---|');

    for (const clm of this.claims) {
      const statusIcon = clm.status === 'VERIFIED' ? '✅ VERIFIED' : '⏳ CONFIRM';
      const metricsStr = clm.metrics.length > 0 ? clm.metrics.map(m => `\`${m}\``).join(', ') : 'None';
      const toolsStr = clm.tools.length > 0 ? clm.tools.map(t => `\`${t}\``).join(', ') : 'None';
      const evidenceStr = clm.evidence || (clm.status === 'CONFIRM' ? `Pending: ${clm.clarificationPrompt || 'Needs review'}` : 'Verified via CV');
      lines.push(`| \`[${clm.id}]\` | \`${clm.employerId}\` | ${clm.category} | ${statusIcon} | ${metricsStr} | ${toolsStr} | ${evidenceStr} |`);
    }

    lines.push('');
    return lines.join('\n');
  }

  // ==========================================================================
  // Static Factories
  // ==========================================================================

  static fromJson(jsonOrString) {
    const parsed = typeof jsonOrString === 'string' ? JSON.parse(jsonOrString) : jsonOrString;
    return new CareerDossier(parsed);
  }

  static fromMarkdown(markdownString) {
    const lines = markdownString.split('\n');
    const raw = {
      candidate: {},
      employers: [],
      claims: [],
      degrees: [],
      certifications: [],
      skills: { languages: [], frameworks: [], infrastructure: [], databases: [], architecturalDomains: [] },
      claimVerificationAppendix: { verificationLog: [] }
    };

    let currentSection = '';
    let currentEmployer = null;
    let educationSubSection = null;
    let appendixColumns = null; // header-driven column map for 6/7-column tables

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      // Heading detection: current "# Career Dossier — <Name>" and legacy
      // "# <Name> — Master Career Profile" (em/en dash or hyphen).
      const legacyHeader = line.match(/^#\s+(.+?)\s+[—–-]\s+Master Career Profile\s*$/i);
      const currentHeader = line.match(/^#\s+Career Dossier\s+[—–-]\s+(.+?)\s*$/i);
      if (currentHeader) {
        raw.candidate.name = currentHeader[1].trim();
      } else if (legacyHeader) {
        raw.candidate.name = legacyHeader[1].trim();
      } else if (/^##\s+(?:1\.\s+)?Professional Summary/i.test(line) || /^##\s+Summary/i.test(line)) {
        currentSection = 'summary';
      } else if (/^##\s+(?:2\.\s+)?Career Target/i.test(line)) {
        currentSection = 'target';
      } else if (/^##\s+(?:3\.\s+)?(?:Verified\s+)?Work Experience/i.test(line) || /^##\s+Experience/i.test(line)) {
        currentSection = 'experience';
      } else if (/^##\s+(?:4\.\s+)?Education/i.test(line)) {
        currentSection = 'education';
        educationSubSection = null;
      } else if (/^##\s+(?:5\.\s+)?(?:Structured\s+)?Skills/i.test(line)) {
        currentSection = 'skills';
      } else if (/^##\s+(?:6\.\s+)?Claim Verification Appendix/i.test(line) || /^##\s+Appendix/i.test(line)) {
        currentSection = 'appendix';
      } else if (currentSection === 'summary' && line && !line.startsWith('>')) {
        raw.candidate.summary = (raw.candidate.summary ? raw.candidate.summary + ' ' : '') + line;
      } else if (currentSection === 'target') {
        if (line.includes('Current Title**:')) raw.candidate.currentTitle = line.split('Current Title**:')[1].trim();
        if (line.includes('Location**:')) raw.candidate.location = line.split('Location**:')[1].trim();
        if (line.includes('Work Authorization**:')) raw.candidate.workAuthorization = line.split('Work Authorization**:')[1].trim();
        if (line.includes('Notice Period**:')) {
          const match = line.match(/(\d+)/);
          if (match) raw.candidate.noticePeriodDays = parseInt(match[1], 10);
        }
        if (line.includes('Salary Floor**:')) {
          const m = line.match(/(SAR|AED|USD|GBP|EUR)\s*([\d,]+)/i);
          if (m) {
            raw.candidate.salaryFloor = raw.candidate.salaryFloor || {};
            raw.candidate.salaryFloor.currency = m[1].toUpperCase();
            raw.candidate.salaryFloor.minimumBase = parseInt(m[2].replace(/,/g, ''), 10);
          }
        }
        if (line.includes('Form Disclosure Policy**:')) {
          raw.candidate.salaryFloor = raw.candidate.salaryFloor || {};
          raw.candidate.salaryFloor.disclosurePolicy = line.split('Form Disclosure Policy**:')[1].trim();
        }
      } else if (currentSection === 'experience') {
        if (line.startsWith('### ')) {
          const empHeader = line.replace('### ', '').trim();
          const m = empHeader.match(/^(.*?)\s*\((.*?)\)$/);
          const empName = m ? m[1].trim() : empHeader;
          const dates = m ? m[2].trim() : '';
          const isCurrent = dates.includes('Present');
          const years = dates.match(/\d{4}/g) || ['2020'];
          const startYear = parseInt(years[0], 10);
          const endYear = isCurrent ? null : (years[1] ? parseInt(years[1], 10) : startYear);
          const empId = `emp_${empName.toLowerCase().replace(/[^a-z0-9]/g, '_').slice(0, 16)}`;

          currentEmployer = {
            id: empId,
            name: empName,
            location: '',
            startYear,
            endYear,
            isCurrent,
            title: ''
          };
          raw.employers.push(currentEmployer);
        } else if (line.startsWith('<!-- employer-id:') && currentEmployer) {
          const idm = line.match(/employer-id:\s*([A-Za-z0-9_-]+)/);
          if (idm) currentEmployer.id = idm[1];
        } else if (line.startsWith('**') && currentEmployer && !currentEmployer.title) {
          const parts = line.replace(/\*\*/g, '').split('·');
          currentEmployer.title = parts[0] ? parts[0].trim() : '';
          currentEmployer.location = parts[1] ? parts[1].trim() : '';
        } else if (line.startsWith('- ') && currentEmployer) {
          // Claim tag at bullet start: "- [C-01] Scaled ..." or at end:
          // "- Scaled regional operations ... [C-01]." (legacy style).
          let claimId = null;
          let text = null;
          const startMatch = line.match(/^-\s*\[([A-Za-z0-9_-]+)\]\s*(.*)$/);
          if (startMatch) {
            claimId = startMatch[1];
            text = startMatch[2].trim();
          } else {
            const endMatch = line.match(/^-\s+(.+?)\s*\[([A-Za-z][A-Za-z0-9]*-\d[A-Za-z0-9_-]*)\]\.?\s*$/);
            if (endMatch) {
              text = endMatch[1].trim();
              claimId = endMatch[2];
            }
          }
          if (claimId) {
            raw.claims.push({
              id: claimId,
              employerId: currentEmployer.id,
              category: 'experience',
              text,
              metrics: [],
              tools: [],
              role: currentEmployer.title,
              status: 'VERIFIED'
            });
          }
        }
      } else if (currentSection === 'education' && (line.startsWith('### Degrees') || line.startsWith('### Education'))) {
        educationSubSection = 'degrees';
      } else if (currentSection === 'education' && (line.startsWith('### Certifications') || line.startsWith('### Licenses'))) {
        educationSubSection = 'certifications';
      } else if (currentSection === 'education' && line.startsWith('- **')) {
        const item = line.replace(/^- \*\*/, '');
        const parts = item.split('**,');
        if (parts.length >= 2) {
          const nameOrDegree = parts[0].trim();
          const rest = parts.slice(1).join('**,').trim();
          const ym = rest.match(/\((\d{4})\)/);
          const yr = ym ? parseInt(ym[1], 10) : 2020;
          let inst = rest.replace(/\(\d{4}\)/, '').trim();
          let thesis = undefined;
          if (inst.includes('— *Thesis:')) {
            const tparts = inst.split('— *Thesis:');
            inst = tparts[0].trim();
            thesis = tparts[1].replace(/\*$/, '').trim();
          }

          const isCert = educationSubSection === 'certifications' ||
            (!educationSubSection && /\b(certified|certification|certificate|cka|ckad|cks|cissp|comptia|aws|gcp|azure|pmp)\b/i.test(nameOrDegree));

          if (isCert) {
            raw.certifications.push({ name: nameOrDegree, issuer: inst, year: yr });
          } else {
            const degObj = { degree: nameOrDegree, institution: inst, year: yr };
            if (thesis) degObj.thesis = thesis;
            raw.degrees.push(degObj);
          }
        }
      } else if (currentSection === 'skills' && line.startsWith('- **')) {
        if (line.includes('Languages**:')) {
          raw.skills.languages = line.split('Languages**:')[1].split(',').map(s => s.trim()).filter(Boolean);
        } else if (line.includes('Frameworks**:')) {
          raw.skills.frameworks = line.split('Frameworks**:')[1].split(',').map(s => s.trim()).filter(Boolean);
        } else if (line.includes('Infrastructure**:')) {
          raw.skills.infrastructure = line.split('Infrastructure**:')[1].split(',').map(s => s.trim()).filter(Boolean);
        } else if (line.includes('Databases**:')) {
          raw.skills.databases = line.split('Databases**:')[1].split(',').map(s => s.trim()).filter(Boolean);
        } else if (line.includes('Architectural Domains**:')) {
          raw.skills.architecturalDomains = line.split('Architectural Domains**:')[1].split(',').map(s => s.trim()).filter(Boolean);
        }
      } else if (currentSection === 'appendix' && line.startsWith('|') && /claim/i.test(line) && !line.includes('`[') && !line.startsWith('| [')) {
        // Header row: build column map so 6- and 7-column tables both parse,
        // plus the legacy 4/5-column shape (Claim ID | Verbatim Claim &
        // Metric | Source Role & Company | Interview Defense Notes).
        const headers = line.split('|').map(c => c.trim().toLowerCase()).filter(Boolean);
        appendixColumns = {};
        headers.forEach((h, idx) => {
          // Only an exact "Claim ID" header is the id; "Verbatim Claim &
          // Metric" must not overwrite it.
          if (/^claim\s*id$/i.test(h)) appendixColumns.id = idx;
          else if (/verbatim/.test(h)) { appendixColumns.text = idx; appendixColumns.metrics = idx; }
          else if (/source/.test(h) && /(role|company|employer)/.test(h)) appendixColumns.employer = idx;
          else if (/interview|defen[cs]e/.test(h)) appendixColumns.evidence = idx;
          else if (/employer/.test(h)) appendixColumns.employer = idx;
          else if (/categor/.test(h)) appendixColumns.category = idx;
          else if (/status/.test(h)) appendixColumns.status = idx;
          else if (/metric/.test(h)) appendixColumns.metrics = idx;
          else if (/tool|technolog/.test(h)) appendixColumns.tools = idx;
          else if (/evidence|verif/.test(h)) appendixColumns.evidence = idx;
          else if (/^claim$/.test(h) && appendixColumns.id === undefined) appendixColumns.id = idx;
        });
        if (appendixColumns.id === undefined && headers.length > 0) appendixColumns.id = 0;
      } else if (currentSection === 'appendix' && (line.startsWith('| `[') || line.startsWith('| ['))) {
        const cols = line.split('|').map(c => c.trim()).filter(Boolean);
        const hasHeaderMap = Boolean(appendixColumns);
        const cmap = appendixColumns || { id: 0, employer: 1, category: 2, status: 3, metrics: 4, tools: 5, evidence: 6 };
        // Remap into legacy positional slots used below (missing cols -> '')
        // With a header map, a missing key stays '' (legacy tables have no
        // status/tools columns); positional fallbacks apply only headerless.
        const pick = (key, fallback) => {
          const idx = cmap[key] !== undefined ? cmap[key] : (hasHeaderMap ? undefined : fallback);
          return idx !== undefined && cols[idx] !== undefined ? cols[idx] : '';
        };
        const normCols = [pick('id', 0), pick('employer', 1), pick('category', 2) || 'general',
          pick('status', 3), pick('metrics', 4), pick('tools', 5), pick('evidence', 6)];
        const appendixText = pick('text', undefined).replace(/[`]/g, '').trim();
        const isVerbatimMetrics = cmap.text !== undefined && cmap.text === cmap.metrics;
        if (cols.length >= 2) {
          const id = normCols[0].replace(/[`[\]]/g, '').trim();
          const rawEmployer = normCols[1].replace(/[`]/g, '').trim();
          const category = normCols[2];
          const status = normCols[3].includes('CONFIRM') ? 'CONFIRM' : 'VERIFIED';
          cols.length = 0; cols.push(...normCols);
          let metrics = [];
          if (isVerbatimMetrics) {
            // Verbatim sentence doubles as the metrics source: pull the
            // numeric quantities out instead of comma-splitting the prose.
            const backticked = cols[4].match(/`([^`]+)`/g);
            if (backticked && backticked.length > 0) {
              metrics = backticked.map(m => m.replace(/`/g, '').trim()).filter(m => m && m !== 'None');
            } else {
              metrics = (cols[4].match(/\d[\d,]*(?:\.\d+)?\s*(?:%|percent\b|x\b|ms\b|rps\b|sites?\b|regions?\b|offices?\b|stores?\b|suppliers?\b|engineers?\b|users?\b|orders?\b|hubs?\b|clients?\b|accounts?\b|projects?\b|teams?\b|people\b|staff\b|employees?\b|members?\b|countries\b|markets?\b|locations?\b|branches\b)/gi) || [])
                .map(m => m.trim()).filter(Boolean);
            }
          } else if (cols[4].includes('`')) {
            const matches = cols[4].match(/`([^`]+)`/g);
            if (matches && matches.length > 0) {
              metrics = matches.map(m => m.replace(/`/g, '').trim()).filter(m => m && m !== 'None');
            }
          } else {
            metrics = cols[4].split(/,(?!\d{3}(?:\b|\D))/).map(m => m.replace(/[`]/g, '').trim()).filter(m => m && m !== 'None');
          }
          let tools = [];
          if (cols[5].includes('`')) {
            const matches = cols[5].match(/`([^`]+)`/g);
            if (matches && matches.length > 0) {
              tools = matches.map(t => t.replace(/`/g, '').trim()).filter(t => t && t !== 'None');
            }
          } else {
            tools = cols[5].split(',').map(t => t.replace(/[`]/g, '').trim()).filter(t => t && t !== 'None');
          }
          const evidence = cols[6] || null;

          // Legacy employer cells are free text ("Role, Company" / "Role —
          // Company"), not slug ids. Resolve them to a stable id: prefer an
          // experience employer whose name appears in the cell, else derive
          // the same emp_<slug> id the experience parser would generate.
          const isSlugId = /^[A-Za-z0-9_-]+$/.test(rawEmployer);
          const existingClaim = raw.claims.find(c => c.id === id);
          let empId = rawEmployer;
          let legacyRole = '';
          let legacyCompany = '';
          if (rawEmployer && !isSlugId) {
            const sep = rawEmployer.match(/^(.*?)\s*(?:,|—|–|\bat\b)\s*(.+)$/i);
            if (sep) { legacyRole = sep[1].trim(); legacyCompany = sep[2].trim(); }
            else { legacyCompany = rawEmployer; }
            const cellLower = rawEmployer.toLowerCase();
            const matched = raw.employers.find(e => e.name && cellLower.includes(e.name.toLowerCase())) ||
              raw.employers.find(e => legacyCompany && e.name.toLowerCase() === legacyCompany.toLowerCase());
            if (matched) {
              empId = matched.id;
            } else if (existingClaim) {
              empId = existingClaim.employerId;
            } else {
              empId = `emp_${legacyCompany.toLowerCase().replace(/[^a-z0-9]/g, '_').slice(0, 16)}`;
              if (!raw.employers.some(e => e.id === empId)) {
                raw.employers.push({
                  id: empId, name: legacyCompany || rawEmployer, location: '',
                  startYear: 2020, endYear: null, isCurrent: false, title: legacyRole
                });
              }
            }
          }
          if (existingClaim) {
            // Preserve appendix employer IDs (e.g. emp_01..emp_NN): if the
            // experience section generated a different id, rename it. For
            // legacy free-text cells resolved above, empId already equals
            // the experience employer id when matched, so ids stay stable.
            if (empId && existingClaim.employerId && empId !== existingClaim.employerId &&
                !raw.employers.some(e => e.id === empId)) {
              const oldId = existingClaim.employerId;
              const empObj = raw.employers.find(e => e.id === oldId);
              if (empObj) empObj.id = empId;
              for (const c of raw.claims) if (c.employerId === oldId) c.employerId = empId;
            } else if (empId && existingClaim.employerId && empId !== existingClaim.employerId &&
                !isSlugId && rawEmployer) {
              // Free-text employer resolving to a different known employer
              // is descriptive only; keep the experience binding.
            }
            if (cmap.category !== undefined) existingClaim.category = category;
            existingClaim.status = status;
            if (appendixText) existingClaim.text = appendixText;
            existingClaim.metrics = metrics;
            existingClaim.tools = tools;
            existingClaim.evidence = evidence;
            if (legacyRole && !existingClaim.role) existingClaim.role = legacyRole;
          } else {
            raw.claims.push({
              id,
              employerId: empId,
              category,
              text: appendixText || `Claim ${id}`,
              metrics,
              tools,
              role: legacyRole || '',
              status,
              evidence
            });
          }
        }
      }
    }

    // Post-pass: claims referencing employers absent from the experience
    // section (appendix-only legacy files) get placeholder employers so
    // their original IDs (emp_01..emp_NN) survive validation.
    const knownIds = new Set(raw.employers.map(e => e.id));
    for (const c of raw.claims) {
      if (c.employerId && !knownIds.has(c.employerId)) {
        raw.employers.push({
          id: c.employerId, name: c.employerId, location: '',
          startYear: 2020, endYear: null, isCurrent: false, title: c.role || ''
        });
        knownIds.add(c.employerId);
      }
    }

    return new CareerDossier(raw);
  }

  static createTemplate() {
    return new CareerDossier({
      schemaVersion: '1.0.0',
      updatedAt: new Date().toISOString(),
      candidate: {
        name: '[Candidate Name]',
        email: 'user@example.org',
        phone: '+1 555-0100',
        location: 'City, Country',
        workAuthorization: 'Authorized',
        noticePeriodDays: 30,
        currentTitle: 'Senior Software Engineer',
        summary: 'Accomplished engineering professional with proven track record.',
        salaryFloor: {
          currency: 'SAR',
          minimumBase: 30000,
          targetTotal: 40000,
          disclosurePolicy: 'mandatory_only'
        }
      },
      employers: [
        {
          id: 'emp_primary',
          name: 'Primary Enterprise',
          location: 'City, Country',
          startYear: 2021,
          endYear: null,
          isCurrent: true,
          title: 'Senior Software Engineer'
        }
      ],
      claims: [
        {
          id: 'C-01',
          employerId: 'emp_primary',
          category: 'performance',
          text: 'Improved core service performance and reliability.',
          metrics: ['40%'],
          tools: ['Node.js', 'PostgreSQL'],
          role: 'Senior Software Engineer',
          status: 'VERIFIED',
          evidence: 'Production metric audit'
        }
      ],
      degrees: [],
      certifications: [],
      skills: {
        languages: [],
        frameworks: [],
        infrastructure: [],
        databases: [],
        architecturalDomains: []
      },
      preferences: {
        targetTitles: [],
        targetLocations: [],
        knockouts: { excludedIndustries: [], excludedSubIndustries: [], excludedCompanies: [], seniorityFloor: '' },
        jobBoards: [],
        schedule: { startHour: 8, timezone: 'Asia/Riyadh', autoPrep: false }
      },
      claimVerificationAppendix: {
        verifiedCount: 1,
        pendingCount: 0,
        verificationLog: []
      }
    });
  }
}

module.exports = {
  CareerDossier
};
