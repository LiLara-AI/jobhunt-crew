'use strict';

/**
 * JobHunt Crew — Stage 7 Apply Pack & Attended Form Pre-Fill
 *
 * Generates self-contained application packages (applications/<Company>_<Role>/apply-pack.md)
 * with position overview, tailored artifact references, claim verification manifest,
 * blind review panel scores, screening answers respecting the candidate's Salary Disclosure Policy,
 * and Chrome DevTools MCP attended pre-fill plan with a non-negotiable submit safety gate.
 *
 * Zero external dependencies. Uses Node.js standard runtime.
 */

const fs = require('fs');
const path = require('path');
const { DocGenerator } = require('./doc-generator');

// Dossier each pre-fill plan was built from, so writeApplyPack can render the CV
// for callers that pass the plan but not the dossier (MCP server, CLI).
const PLAN_DOSSIERS = new WeakMap();

const bareId = id => String(id).replace(/^\[|\]$/g, '').trim();

class ApplyPackGenerator {
  /**
   * Generates screening answers respecting the candidate's salary policy.
   * Every statement comes from the dossier; nothing is assumed about the candidate's field.
   */
  static generateScreeningAnswers(dossier, jobRecord = {}) {
    const candidate = dossier.candidate || {};
    const floor = candidate.salaryFloor || { currency: 'SAR', minimumBase: 0, disclosurePolicy: 'mandatory_only' };
    const currency = floor.currency || 'SAR';
    const minBase = floor.minimumBase ? floor.minimumBase.toLocaleString() : '';
    const policy = floor.disclosurePolicy || 'mandatory_only';

    let salaryAnswer = '';
    if (policy === 'negotiable_placeholder') {
      salaryAnswer = 'Negotiable / Open to competitive market compensation.';
    } else if (!minBase) {
      salaryAnswer = 'Leave blank if optional. No salary floor is recorded in the dossier; decide the figure yourself if the field is mandatory.';
    } else if (policy === 'mandatory_only' || policy === 'leave_blank_if_optional') {
      salaryAnswer = `Leave blank if optional. If mandatory numeric field, enter ${minBase} (${currency}).`;
    } else {
      salaryAnswer = `${minBase} ${currency} / month base minimum.`;
    }

    const claim = (Array.isArray(dossier.claims) ? dossier.claims : [])
      .find(c => c && c.text && (!c.status || c.status === 'VERIFIED'));
    const sentence = s => (/[.!?]$/.test(String(s).trim()) ? String(s).trim() : `${String(s).trim()}.`);
    const motivation = [
      jobRecord.title
        ? `I am interested in the ${jobRecord.title} role at ${jobRecord.company || 'your organization'}.`
        : `I am interested in joining ${jobRecord.company || 'the team'}.`,
      candidate.currentTitle ? `My current role: ${candidate.currentTitle}.` : '',
      candidate.summary ? sentence(candidate.summary) : '',
      claim ? `One result I delivered: ${sentence(claim.text)}` : ''
    ].filter(Boolean).join(' ');

    return {
      workAuthorization: candidate.workAuthorization || '',
      noticePeriod: Number.isFinite(candidate.noticePeriodDays) ? `${candidate.noticePeriodDays} Days` : '',
      salaryExpectations: salaryAnswer,
      customMotivation: motivation
    };
  }

  /**
   * Builds the attended browser pre-fill plan for Chrome DevTools MCP.
   * Safety invariant: Never clicks submit.
   */
  static buildPreFillPlan(jobRecord, dossier) {
    const candidate = dossier.candidate || {};
    const answers = ApplyPackGenerator.generateScreeningAnswers(dossier, jobRecord);
    const floor = candidate.salaryFloor || {};
    const skippedFields = [];
    const fieldMappings = [
      { selector: 'input[name*="name"], input[id*="name"], input[data-automation-id*="legalName"]', value: candidate.name, type: 'text' },
      { selector: 'input[name*="email"], input[type="email"], input[data-automation-id*="email"]', value: candidate.email, type: 'text' },
      { selector: 'input[name*="phone"], input[type="tel"], input[data-automation-id*="phone"]', value: candidate.phone, type: 'text' },
      { selector: 'select[name*="auth"], select[name*="visa"], select[data-automation-id*="workAuth"]', value: answers.workAuthorization, type: 'select' },
      { selector: 'input[name*="notice"], select[name*="notice"]', value: answers.noticePeriod, type: 'text' }
    ].filter(m => m.value); // never type "undefined" or a guess into a form

    // Salary inputs are numeric: only a bare number is ever typed, and only when the
    // policy says to always disclose. Otherwise the field is left for the human.
    if (floor.disclosurePolicy === 'always_disclose' && floor.minimumBase > 0) {
      fieldMappings.push({ selector: 'input[name*="salary"], input[name*="comp"], input[data-automation-id*="salary"]', value: String(floor.minimumBase), type: 'text' });
    } else {
      skippedFields.push({ field: 'salary', reason: `Not pre-filled (disclosure policy: ${floor.disclosurePolicy || 'mandatory_only'}). ${answers.salaryExpectations}` });
    }

    const plan = {
      jobId: jobRecord.id || 'job_target',
      company: jobRecord.company || 'Enterprise',
      targetUrl: jobRecord.url || 'https://careers.example.org',
      fieldMappings,
      skippedFields,
      safetyGate: {
        prohibitedSelectors: ['button[type="submit"]', 'input[type="submit"]', 'button:contains("Submit")', 'button:contains("Confirm")'],
        status: 'ready-to-submit',
        actionRemaining: 'Human candidate must review fields, attach CV, and click final Submit'
      }
    };

    ApplyPackGenerator.validateSafetyGate(plan);
    PLAN_DOSSIERS.set(plan, dossier);
    return plan;
  }

  /**
   * Renders the CV files the pack lists into the application folder and reports
   * what is really on disk. Existing files are kept, never overwritten.
   * @returns {{ artifacts: Object<string,string>, artifactNotes: string[] }}
   */
  static renderArtifacts(appDir, slug, dossier, packData = {}) {
    const artifacts = {};
    const artifactNotes = [];
    const used = (packData.claimsUsed || []).map(bareId);
    const cv = dossier && dossier.candidate && dossier.candidate.name
      ? { ...dossier, claims: (dossier.claims || []).filter(c => c && (!used.length || used.includes(bareId(c.id)))) }
      : null;
    const renderers = packData.artifacts ? {} : {
      cvDocx: () => DocGenerator.generateCvDocx(cv),
      cvPdf: () => DocGenerator.generateCvPdf(cv, { quiet: true })
    };
    const names = packData.artifacts || {
      cvDocx: `CV_${slug}.docx`,
      cvPdf: `CV_${slug}.pdf`,
      coverLetterDocx: `CoverLetter_${slug}.docx`
    };

    for (const [key, name] of Object.entries(names)) {
      if (!name) continue;
      const file = path.resolve(appDir, String(name));
      if (fs.existsSync(file)) {
        artifacts[key] = name;
        if (renderers[key]) artifactNotes.push(`\`${name}\` already existed and was kept as is. Delete it and rebuild this pack to regenerate it from the dossier.`);
      } else if (renderers[key] && cv) {
        try {
          fs.writeFileSync(file, renderers[key]());
          artifacts[key] = name;
        } catch (err) {
          artifactNotes.push(`\`${name}\` was NOT generated: ${err.message}`);
        }
      } else if (packData.artifacts) {
        artifactNotes.push(`\`${name}\` was listed for this pack but does not exist on disk.`);
      }
    }
    if (!packData.artifacts && !cv) {
      artifactNotes.push('No CV was generated: no dossier with a candidate name was available. Create `dossier.json` (setup skill), then rebuild this pack.');
    }
    if (!packData.artifacts && !artifacts.coverLetterDocx) {
      artifactNotes.push(`No cover letter file yet. Rebuild this pack with the verified letter in \`cover_letter_text\` to create \`${names.coverLetterDocx}\`.`);
    }
    return { artifacts, artifactNotes };
  }

  /**
   * Asserts that no pre-fill action triggers automated submission.
   */
  static validateSafetyGate(plan) {
    if (!plan || !plan.safetyGate) {
      throw new Error('SAFETY_GATE_VIOLATION: Missing safetyGate specification in pre-fill plan');
    }
    if (plan.safetyGate.status !== 'ready-to-submit') {
      throw new Error(`SAFETY_GATE_VIOLATION: Status must be "ready-to-submit", got "${plan.safetyGate.status}"`);
    }

    for (const mapping of plan.fieldMappings || []) {
      const sel = mapping.selector.toLowerCase();
      if (sel.includes('submit') || sel.includes('button[type="submit"]') || sel.includes('save_and_submit')) {
        throw new Error(`SAFETY_GATE_VIOLATION: Pre-fill plan targets submission selector: "${mapping.selector}"`);
      }
    }

    return true;
  }

  /**
   * Compiles the Markdown content for apply-pack.md.
   */
  /**
   * Reads the recorded verification and review for a job from a snapshot
   * application record, so the pack reports what actually ran.
   */
  static checksFromApplication(app) {
    const verification = app && app.verification ? app.verification : null;
    const reviewVerdict = app && app.review
      ? { verdict: app.review.verdict, overallScore: app.review.score }
      : null;
    return { verification, reviewVerdict };
  }

  /**
   * Gate shared by the MCP tool and the CLI. Throws when the job's recorded
   * verification failed (rule 3: no pack on a rejected draft); otherwise lists
   * what is not yet recorded as passed. Only recorded results count, because
   * the submit gate reads the ledger too.
   */
  static submissionBlockers(recorded) {
    const { verification, reviewVerdict } = recorded || {};
    if (verification && verification.passed !== true) {
      throw new Error('GUARDRAIL_VIOLATION: Claim verification FAILED for this job. Fix the draft, re-run crew_verify_draft with job_id until it passes, then build the pack.');
    }
    const blockers = [];
    if (!verification) blockers.push('Claim verification is not recorded for this job: run crew_verify_draft with job_id.');
    // Exact match, like the submit gate.
    if (!reviewVerdict || reviewVerdict.verdict !== 'APPROVE') {
      blockers.push('Blind review is not recorded as APPROVE for this job: run crew_blind_review, then crew_review_record with job_id.');
    }
    return blockers;
  }

  static compileApplyPackMarkdown(packData) {
    const {
      company,
      roleTitle,
      jobUrl,
      matchScore,
      artifacts,
      claimsUsed,
      reviewVerdict,
      verification,
      screeningAnswers,
      preFillPlan
    } = packData;

    const lines = [];
    // Never report a gate as passed unless its result was recorded.
    const verifierLabel = !verification ? 'NOT RUN'
      : (verification.passed === true ? 'PASSED'
        : 'FAILED (' + (verification.violationsCount || (verification.violations || []).length) + ' violations)');
    const reviewLabel = reviewVerdict && reviewVerdict.verdict ? String(reviewVerdict.verdict) : 'NOT RUN';
    const fmtScore = (v) => (typeof v === 'number' && Number.isFinite(v) ? v + ' / 5.0' : 'n/a');

    lines.push(`# Stage 7 Apply Pack: ${company} — ${roleTitle}`);
    lines.push('');
    const blockers = Array.isArray(packData.blockers) ? packData.blockers : [];
    lines.push('> **Status**: `' + (blockers.length ? 'blocked' : 'ready-to-submit') + '` · Claim verification: ' + verifierLabel + ' · Blind review: ' + reviewLabel);
    if (blockers.length || verifierLabel !== 'PASSED' || reviewLabel !== 'APPROVE') {
      lines.push('>');
      lines.push('> ⚠ Do not submit until claim verification has PASSED and the blind review is APPROVE.');
      for (const b of blockers) lines.push('> - ' + b);
    }
    lines.push('');

    // Section 1: Position Overview
    lines.push('## 1. Position & Channel Overview');
    lines.push(`- **Enterprise**: ${company}`);
    lines.push(`- **Role Title**: ${roleTitle}`);
    lines.push(`- **Posting URL**: ${jobUrl || 'N/A'}`);
    lines.push('- **Triage Match Score**: ' + (typeof matchScore === 'number' && Number.isFinite(matchScore) ? fmtScore(matchScore) : 'not triaged'));
    lines.push('');

    // Section 2: Tailored Artifacts
    // Only files that exist on disk are listed (see renderArtifacts); never a phantom name.
    lines.push('## 2. Tailored Application Artifacts');
    const listed = artifacts || {};
    if (listed.cvDocx) lines.push(`- **CV (DOCX)**: \`${listed.cvDocx}\``);
    if (listed.cvPdf) lines.push(`- **CV (PDF)**: \`${listed.cvPdf}\``);
    if (listed.coverLetterDocx) lines.push(`- **Cover Letter (DOCX)**: \`${listed.coverLetterDocx}\``);
    for (const note of packData.artifactNotes || []) lines.push(`- ⚠ ${note}`);
    if (!Object.keys(listed).length && !(packData.artifactNotes || []).length) {
      lines.push('- No documents have been generated for this pack yet.');
    }
    lines.push('');

    // Section 3: Claim Verification Manifest
    lines.push('## 3. Claim Verification Manifest');
    lines.push('- **Verifier Status**: `' + verifierLabel + '`');
    if (!verification) lines.push('- Run `crew_verify_draft` (CLI `crew claim verify`) on the CV and cover letter, then rebuild this pack.');
    if (claimsUsed && claimsUsed.length > 0) {
      lines.push(`- **Verified Claims Referenced**: ${claimsUsed.map(c => `\`[${c}]\``).join(', ')}`);
    } else {
      lines.push('- **Verified Claims Referenced**: none listed.');
    }
    lines.push('');

    // Section 4: Blind Review Panel
    lines.push('## 4. Blind Review Panel Evaluation');
    if (reviewVerdict) {
      lines.push('- **Verdict**: `' + reviewLabel + '`');
      lines.push('- **Overall Score**: ' + fmtScore(reviewVerdict.overallScore));
      if (reviewVerdict.recruiter && Array.isArray(reviewVerdict.recruiter.feedback)) {
        lines.push('- **Recruiter Feedback**: ' + reviewVerdict.recruiter.feedback.join('; '));
      }
      if (reviewVerdict.hiringManager && Array.isArray(reviewVerdict.hiringManager.feedback)) {
        lines.push('- **Hiring Manager Feedback**: ' + reviewVerdict.hiringManager.feedback.join('; '));
      }
    } else {
      lines.push('- **Verdict**: `NOT RUN`');
      lines.push('- Run `crew_blind_review`, record it with `crew_review_record`, then rebuild this pack.');
    }
    lines.push('');

    // Section 5: Screening Answers
    lines.push('## 5. Pre-Drafted Screening Answers');
    if (screeningAnswers) {
      const orMissing = v => v || 'not recorded in the dossier (answer this yourself)';
      lines.push(`- **Work Authorization**: ${orMissing(screeningAnswers.workAuthorization)}`);
      lines.push(`- **Notice Period**: ${orMissing(screeningAnswers.noticePeriod)}`);
      lines.push(`- **Salary Expectations**: ${screeningAnswers.salaryExpectations}`);
      if (screeningAnswers.customMotivation) {
        lines.push(`- **Motivation / Why this role?**: ${screeningAnswers.customMotivation}`);
      }
    }
    lines.push('');

    // Section 6: Attended Pre-Fill Plan & Safety Gate
    lines.push('## 6. Attended Browser Pre-Fill Instructions');
    lines.push('> **SAFETY GATE ACTIVE**: Automation stops strictly before final submission.');
    lines.push('- **Automation State**: `ready-to-submit`');
    lines.push('- **Remaining Human Action**: Human candidate must review form fields, attach tailored CV, and click final Submit button.');
    lines.push('');
    lines.push('### Pre-Fill Field Mappings:');
    if (preFillPlan && Array.isArray(preFillPlan.fieldMappings)) {
      for (const m of preFillPlan.fieldMappings) {
        lines.push(`- \`${m.selector}\` $\\to$ "${m.value}"`);
      }
    }
    for (const s of (preFillPlan && preFillPlan.skippedFields) || []) {
      lines.push(`- **${s.field}**: ${s.reason}`);
    }
    lines.push('');

    return lines.join('\n');
  }

  /**
   * Generates and writes apply-pack.md to disk.
   */
  static writeApplyPack(workspaceDir, company, roleTitle, packData = {}) {
    // Unicode-aware so non-Latin (e.g. Arabic) names do not collapse to underscores and collide.
    const toSlug = (s) => String(s).replace(/[^\p{L}\p{N}]/gu, '_');
    const slug = `${toSlug(company)}_${toSlug(roleTitle)}`;
    const appDir = path.join(workspaceDir, 'applications', slug);

    if (!fs.existsSync(appDir)) {
      fs.mkdirSync(appDir, { recursive: true });
    }

    // Cover letter text supplied by the caller. Like the CV, an existing file is kept, never overwritten.
    let letterKept = '';
    if (!packData.artifacts && typeof packData.coverLetterText === 'string' && packData.coverLetterText.trim()) {
      const letterName = `CoverLetter_${slug}.docx`;
      const letterFile = path.join(appDir, letterName);
      if (fs.existsSync(letterFile)) {
        letterKept = `\`${letterName}\` already existed and was kept, so the cover letter text passed in was NOT saved. Delete the file and rebuild to replace it, or rebuild without cover letter text to keep it.`;
      } else {
        fs.writeFileSync(letterFile, DocGenerator.generateCoverLetterDocx(packData.coverLetterText));
      }
    }

    const dossier = packData.dossier || PLAN_DOSSIERS.get(packData.preFillPlan) || null;
    const { artifacts, artifactNotes } = ApplyPackGenerator.renderArtifacts(appDir, slug, dossier, packData);
    // An unsaved letter is a blocker, not a footnote: the pack must not look ready.
    if (letterKept) {
      artifactNotes.push(letterKept);
      if (Array.isArray(packData.blockers)) packData.blockers.push(letterKept);
    }

    const fullPackData = {
      company,
      roleTitle,
      jobUrl: packData.jobUrl || '',
      matchScore: packData.matchScore,
      artifacts,
      artifactNotes,
      claimsUsed: packData.claimsUsed || [],
      reviewVerdict: packData.reviewVerdict || null,
      verification: packData.verification || null,
      blockers: packData.blockers,
      screeningAnswers: packData.screeningAnswers || {},
      preFillPlan: packData.preFillPlan || { safetyGate: { status: 'ready-to-submit' } }
    };

    const md = ApplyPackGenerator.compileApplyPackMarkdown(fullPackData);
    const filePath = path.join(appDir, 'apply-pack.md');
    fs.writeFileSync(filePath, md, 'utf8');

    return {
      slug,
      dir: appDir,
      filePath,
      relativePath: path.join('applications', slug, 'apply-pack.md'),
      artifacts,
      artifactNotes
    };
  }
}

module.exports = {
  ApplyPackGenerator
};
