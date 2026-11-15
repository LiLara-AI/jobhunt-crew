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

class ApplyPackGenerator {
  /**
   * Generates screening answers respecting the candidate's salary policy.
   */
  static generateScreeningAnswers(dossier, jobRecord = {}) {
    const candidate = dossier.candidate || {};
    const floor = candidate.salaryFloor || { currency: 'SAR', minimumBase: 0, disclosurePolicy: 'mandatory_only' };
    const currency = floor.currency || 'SAR';
    const minBase = floor.minimumBase ? floor.minimumBase.toLocaleString() : '0';
    const policy = floor.disclosurePolicy || 'mandatory_only';

    let salaryAnswer = '';
    if (policy === 'mandatory_only' || policy === 'leave_blank_if_optional') {
      salaryAnswer = `Leave blank if optional. If mandatory numeric field, enter ${minBase} (${currency}).`;
    } else if (policy === 'negotiable_placeholder') {
      salaryAnswer = 'Negotiable / Open to competitive market compensation.';
    } else {
      salaryAnswer = `${minBase} ${currency} / month base minimum.`;
    }

    return {
      workAuthorization: candidate.workAuthorization || 'Authorized to work',
      noticePeriod: `${candidate.noticePeriodDays || 30} Days`,
      salaryExpectations: salaryAnswer,
      customMotivation: `I am interested in joining ${jobRecord.company || 'the team'} to leverage my proven background in distributed systems and architecture.`
    };
  }

  /**
   * Builds the attended browser pre-fill plan for Chrome DevTools MCP.
   * Safety invariant: Never clicks submit.
   */
  static buildPreFillPlan(jobRecord, dossier) {
    const candidate = dossier.candidate || {};
    const answers = ApplyPackGenerator.generateScreeningAnswers(dossier, jobRecord);

    const plan = {
      jobId: jobRecord.id || 'job_target',
      company: jobRecord.company || 'Enterprise',
      targetUrl: jobRecord.url || 'https://careers.example.org',
      fieldMappings: [
        { selector: 'input[name*="name"], input[id*="name"], input[data-automation-id*="legalName"]', value: candidate.name, type: 'text' },
        { selector: 'input[name*="email"], input[type="email"], input[data-automation-id*="email"]', value: candidate.email, type: 'text' },
        { selector: 'input[name*="phone"], input[type="tel"], input[data-automation-id*="phone"]', value: candidate.phone, type: 'text' },
        { selector: 'select[name*="auth"], select[name*="visa"], select[data-automation-id*="workAuth"]', value: answers.workAuthorization, type: 'select' },
        { selector: 'input[name*="notice"], select[name*="notice"]', value: answers.noticePeriod, type: 'text' },
        { selector: 'input[name*="salary"], input[name*="comp"], input[data-automation-id*="salary"]', value: answers.salaryExpectations, type: 'text' }
      ],
      safetyGate: {
        prohibitedSelectors: ['button[type="submit"]', 'input[type="submit"]', 'button:contains("Submit")', 'button:contains("Confirm")'],
        status: 'ready-to-submit',
        actionRemaining: 'Human candidate must review fields, attach CV, and click final Submit'
      }
    };

    ApplyPackGenerator.validateSafetyGate(plan);
    return plan;
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
    lines.push('> **Status**: `ready-to-submit` · Claim verification: ' + verifierLabel + ' · Blind review: ' + reviewLabel);
    if (verifierLabel !== 'PASSED' || reviewLabel !== 'APPROVE') {
      lines.push('>');
      lines.push('> ⚠ Do not submit until claim verification has PASSED and the blind review is APPROVE.');
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
    lines.push('## 2. Tailored Application Artifacts');
    if (artifacts) {
      if (artifacts.cvDocx) lines.push(`- **CV (DOCX)**: \`${artifacts.cvDocx}\``);
      if (artifacts.cvPdf) lines.push(`- **CV (PDF)**: \`${artifacts.cvPdf}\``);
      if (artifacts.coverLetterDocx) lines.push(`- **Cover Letter (DOCX)**: \`${artifacts.coverLetterDocx}\``);
    } else {
      lines.push(`- **CV (DOCX)**: \`CV_${company.replace(/\s+/g, '_')}_${roleTitle.replace(/\s+/g, '_')}.docx\``);
      lines.push(`- **CV (PDF)**: \`CV_${company.replace(/\s+/g, '_')}_${roleTitle.replace(/\s+/g, '_')}.pdf\``);
      lines.push(`- **Cover Letter (DOCX)**: \`CoverLetter_${company.replace(/\s+/g, '_')}_${roleTitle.replace(/\s+/g, '_')}.docx\``);
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
      lines.push(`- **Work Authorization**: ${screeningAnswers.workAuthorization}`);
      lines.push(`- **Notice Period**: ${screeningAnswers.noticePeriod}`);
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

    const fullPackData = {
      company,
      roleTitle,
      jobUrl: packData.jobUrl || '',
      matchScore: packData.matchScore,
      artifacts: packData.artifacts || {
        cvDocx: `CV_${slug}.docx`,
        cvPdf: `CV_${slug}.pdf`,
        coverLetterDocx: `CoverLetter_${slug}.docx`
      },
      claimsUsed: packData.claimsUsed || [],
      reviewVerdict: packData.reviewVerdict || null,
      verification: packData.verification || null,
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
      relativePath: path.join('applications', slug, 'apply-pack.md')
    };
  }
}

module.exports = {
  ApplyPackGenerator
};
