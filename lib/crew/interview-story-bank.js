'use strict';

/**
 * JobHunt Crew — STAR+R Interview Story Bank & Pack Generator
 *
 * Implements:
 * - Situation, Task, Action, Result + Reflection (STAR+R) behavioral story model.
 * - Deterministic claim binding ([C-xx] / [CLM-xxx]) against Candidate Dossier.
 * - Metric and employer integrity enforcement (zero fabrication).
 * - Confirmation gating (blocks unconfirmed claims from finalized packs).
 * - Automated interview-pack.md compilation on interview invite signals.
 *
 * @module lib/crew/interview-story-bank
 */

class StarRStoryBank {
  /**
   * @param {Object} [dossier] Candidate dossier JSON
   */
  constructor(dossier = {}) {
    this.dossier = dossier || {};
    this.stories = new Map();

    if (Array.isArray(this.dossier.storyBank)) {
      for (const s of this.dossier.storyBank) {
        this.addStory(s);
      }
    } else if (Array.isArray(this.dossier.stories)) {
      for (const s of this.dossier.stories) {
        this.addStory(s);
      }
    }
  }

  /**
   * Validates story structural integrity and deterministic claim binding.
   * @param {Object} story
   * @returns {Object} Validated story record
   */
  validateStory(story) {
    if (!story || typeof story !== 'object') {
      throw new Error('Story must be a non-empty object');
    }

    const requiredFields = ['situation', 'task', 'action', 'result', 'reflection'];
    for (const f of requiredFields) {
      if (!story[f] || typeof story[f] !== 'string' || story[f].trim().length === 0) {
        throw new Error(`Missing or empty required STAR+R field: "${f}"`);
      }
    }

    if (!story.claimId) {
      throw new Error('Story must have a claimId bound to candidate dossier');
    }

    // Claim binding check if dossier has claims
    const claims = Array.isArray(this.dossier.claims) ? this.dossier.claims : [];
    if (claims.length > 0) {
      const boundClaim = claims.find(c => (c.id === story.claimId || c.claimId === story.claimId || c.tag === story.claimId));
      if (!boundClaim) {
        throw new Error(`UNBOUND_STORY_CLAIM_ERROR: Claim "${story.claimId}" not found in candidate dossier`);
      }

      // Check employer integrity
      if (story.employerId && boundClaim.employerId && story.employerId !== boundClaim.employerId) {
        throw new Error(`EMPLOYER_MISMATCH_ERROR: Story employer "${story.employerId}" does not match claim employer "${boundClaim.employerId}"`);
      }

      // Check metric consistency
      const declaredMetrics = (boundClaim.metrics || []).map(m => String(m).toLowerCase());
      if (story.metrics && Array.isArray(story.metrics)) {
        for (const sm of story.metrics) {
          const smStr = String(sm).toLowerCase();
          const matches = declaredMetrics.some(dm => dm.includes(smStr) || smStr.includes(dm));
          if (!matches) {
            throw new Error(`UNBOUND_STORY_METRIC_ERROR: Story result contains metric "${sm}" not declared in bound claim "${boundClaim.id || boundClaim.claimId}"`);
          }
        }
      }

      // Confirmation gating
      if (boundClaim.status === 'CONFIRM' || boundClaim.needsConfirmation) {
        story.status = 'DRAFT_PENDING_CONFIRMATION';
        story.confirmed = false;
      } else {
        story.status = story.status || 'CONFIRMED';
        story.confirmed = true;
      }
    } else {
      story.status = story.status || 'CONFIRMED';
      story.confirmed = story.confirmed !== false;
    }

    story.rubric = StarRStoryBank.scoreStory(story);
    return story;
  }

  /**
   * Scores a story on five dimensions, each 0-5 points (25 total).
   * Scoring is deterministic text analysis only: length bands, quantified
   * evidence, ownership language, sequenced actions, and a forward-looking
   * reflection. It never invents content; it only grades what is present.
   */
  static scoreStory(story) {
    const text = field => (story && typeof story[field] === 'string' ? story[field].trim() : '');
    const wordCount = value => (value ? value.split(/\s+/).filter(Boolean).length : 0);
    const lengthPoints = words => (words === 0 ? 0 : words < 6 ? 1 : words < 12 ? 2 : words < 25 ? 3 : 4);
    const hasNumber = value => /\d/.test(value);
    const hasMetricShape = value => /(\d+(\.\d+)?\s*(%|percent|x\b|ms\b|s\b|rps|users|engineers|nodes|days|hours)|\$|SAR|AED|\d{1,3}(,\d{3})+)/i.test(value);

    const situationText = text('situation');
    const taskText = text('task');
    const actionText = text('action');
    const resultText = text('result');
    const reflectionText = text('reflection');

    // Situation: enough context, plus a concrete constraint or scale signal.
    let situation = lengthPoints(wordCount(situationText));
    if (hasNumber(situationText) || /\b(deadline|outage|failure|risk|constraint|pressure|scale|incident)\b/i.test(situationText)) situation += 1;

    // Task: a defined goal, ideally with ownership and a target.
    let task = lengthPoints(wordCount(taskText));
    if (/\b(I|my|own|lead|responsible|tasked|goal|target)\b/i.test(taskText) || hasNumber(taskText)) task += 1;

    // Action: sequenced, first-person steps read stronger than a summary.
    let action = lengthPoints(wordCount(actionText));
    const stepSignals = (actionText.match(/\b(then|first|next|finally|and|before|after)\b/gi) || []).length;
    if (stepSignals >= 2 || /\bI\b/.test(actionText)) action += 1;

    // Result: quantified outcomes are the whole point of the format.
    let result = lengthPoints(wordCount(resultText));
    if (hasMetricShape(resultText)) result += 1;
    else if (hasNumber(resultText)) result += 0.5;
    if (story && Array.isArray(story.metrics) && story.metrics.length > 0 && result < 5) result = Math.min(5, result + 0.5);

    // Reflection: a lesson carried forward, not a restatement.
    let reflection = lengthPoints(wordCount(reflectionText));
    if (/\b(learn|lesson|next time|in future|going forward|would|now I|changed how)\b/i.test(reflectionText)) reflection += 1;

    const cap = value => Math.max(0, Math.min(5, Number(value.toFixed(1))));
    const dimensions = {
      situation: cap(situation),
      task: cap(task),
      action: cap(action),
      result: cap(result),
      reflection: cap(reflection)
    };
    const total = Number(Object.values(dimensions).reduce((sum, v) => sum + v, 0).toFixed(1));
    const maxTotal = 25;
    const percentage = Math.round((total / maxTotal) * 100);
    const weakest = Object.entries(dimensions).sort((a, b) => a[1] - b[1])[0][0];
    const grade = percentage >= 80 ? 'STRONG' : percentage >= 60 ? 'READY' : percentage >= 40 ? 'DEVELOPING' : 'NEEDS_WORK';

    return { dimensions, total, maxTotal, percentage, grade, weakestDimension: weakest };
  }

  scoreStory(story) {
    return StarRStoryBank.scoreStory(story);
  }

  /**
   * Adds and indexes a validated story in the story bank.
   */
  addStory(story) {
    const validated = this.validateStory(story);
    const id = validated.id || `story_${this.stories.size + 1}`;
    validated.id = id;
    this.stories.set(id, validated);
    return validated;
  }

  /**
   * Retrieves matching stories for a target job record.
   */
  getStoriesForRole(jobRecord) {
    const list = Array.isArray(jobRecord) ? jobRecord : Array.from(this.stories.values());
    // Strongest confirmed stories first, by rubric total.
    return list
      .filter(s => s.confirmed !== false && s.status !== 'DRAFT_PENDING_CONFIRMATION')
      .slice()
      .sort((a, b) => {
        const scoreA = a.rubric ? a.rubric.total : StarRStoryBank.scoreStory(a).total;
        const scoreB = b.rubric ? b.rubric.total : StarRStoryBank.scoreStory(b).total;
        return scoreB - scoreA;
      });
  }

  /**
   * Compiles complete interview-pack.md preparation guide.
   * @param {Object} jobRecord
   * @param {Array<string>} [selectedStoryIds]
   * @returns {Object} Compiled interview pack
   */
  generateInterviewPack(jobRecord = {}, selectedStoryIds = null) {
    const company = jobRecord.company || 'Target Enterprise';
    const title = jobRecord.title || 'Target Role';

    let matchedStories = [];
    if (selectedStoryIds && Array.isArray(selectedStoryIds)) {
      matchedStories = selectedStoryIds
        .map(id => this.stories.get(id))
        .filter(s => s && s.confirmed !== false);
    } else {
      matchedStories = this.getStoriesForRole(jobRecord).slice(0, 4);
    }

    const lines = [];
    lines.push(`# Interview Preparation Pack: ${title} @ ${company}\n`);
    lines.push(`**Compiled On:** ${new Date().toISOString()}`);
    lines.push(`**Target Company:** ${company}`);
    lines.push(`**Target Role:** ${title}\n`);
    lines.push('---\n');

    lines.push('## 1. Mapped STAR+R Behavioral Stories (Truth-Anchored)\n');
    if (matchedStories.length === 0) {
      lines.push('*No confirmed STAR+R stories mapped. Verify candidate claims in dossier to activate story bank.*\n');
    } else {
      for (let i = 0; i < matchedStories.length; i++) {
        const s = matchedStories[i];
        lines.push(`### Story ${i + 1}: ${s.title || 'Key Achievement'} (Claim: \`[${s.claimId}]\`)`);
        lines.push(`- **Situation (S):** ${s.situation}`);
        lines.push(`- **Task (T):** ${s.task}`);
        lines.push(`- **Action (A):** ${s.action}`);
        lines.push(`- **Result (R):** ${s.result}`);
        lines.push(`- **Reflection (+R):** ${s.reflection}`);
        const rubric = s.rubric || StarRStoryBank.scoreStory(s);
        const d = rubric.dimensions;
        lines.push(`- **Rubric:** ${rubric.total}/${rubric.maxTotal} (${rubric.percentage}%, ${rubric.grade}) — S:${d.situation} T:${d.task} A:${d.action} R:${d.result} +R:${d.reflection}; weakest: ${rubric.weakestDimension}\n`);
      }
    }

    lines.push('---\n');
    lines.push('## 2. Anticipated Behavioral & Technical Questions\n');
    // Role-neutral on purpose: the pack is built for any profession, not only engineering.
    lines.push('1. **Pressure & Recovery:** "Tell me about a serious problem you diagnosed and resolved under time pressure. What did you do first?"');
    lines.push('2. **Trade-offs:** "Describe a time a deadline conflicted with doing the work the way you thought was right. How did you decide?"');
    lines.push('3. **Cross-Functional Influence:** "How do you get other teams to agree on a priority that costs them time?"\n');

    lines.push('---\n');
    lines.push('## 3. High-Leverage Reverse-Interview Questions (For Interviewer)\n');
    lines.push('1. "How does the team decide between fixing long-standing problems and delivering new work?"');
    lines.push('2. "When something goes wrong in this role, what does the review afterwards look like?"');
    lines.push('3. "What is the single most critical capability or outcome this hire must achieve in their first 90 days?"\n');

    const markdown = lines.join('\n');

    return {
      company,
      role: title,
      storiesCount: matchedStories.length,
      storyScores: matchedStories.map(s => ({
        storyId: s.id,
        claimId: s.claimId,
        rubric: s.rubric || StarRStoryBank.scoreStory(s)
      })),
      markdown
    };
  }
}

module.exports = {
  StarRStoryBank
};
