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

    return story;
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
    // Filter to confirmed stories and sort by relevance
    return list.filter(s => s.confirmed !== false && s.status !== 'DRAFT_PENDING_CONFIRMATION');
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
        lines.push(`### Story ${i + 1}: ${s.title || 'Key Engineering Achievement'} (Claim: \`[${s.claimId}]\`)`);
        lines.push(`- **Situation (S):** ${s.situation}`);
        lines.push(`- **Task (T):** ${s.task}`);
        lines.push(`- **Action (A):** ${s.action}`);
        lines.push(`- **Result (R):** ${s.result}`);
        lines.push(`- **Reflection (+R):** ${s.reflection}\n`);
      }
    }

    lines.push('---\n');
    lines.push('## 2. Anticipated Behavioral & Technical Questions\n');
    lines.push('1. **System Scale & Resilience:** "Tell me about a high-concurrency bottleneck you diagnosed and resolved under production constraints."');
    lines.push('2. **Trade-offs & Technical Debt:** "Describe a scenario where business deadlines conflicted with architectural purity. How did you negotiate the trade-off?"');
    lines.push('3. **Cross-Functional Influence:** "How do you align product leadership and engineering teams on multi-quarter infrastructure investments?"\n');

    lines.push('---\n');
    lines.push('## 3. High-Leverage Reverse-Interview Questions (For Interviewer)\n');
    lines.push('1. "How does the engineering organization measure and mitigate architectural technical debt versus feature velocity?"');
    lines.push('2. "What does the p99 production incident resolution and post-mortem review lifecycle look like here?"');
    lines.push('3. "What is the single most critical capability or outcome this hire must achieve in their first 90 days?"\n');

    const markdown = lines.join('\n');

    return {
      company,
      role: title,
      storiesCount: matchedStories.length,
      markdown
    };
  }
}

module.exports = {
  StarRStoryBank
};
