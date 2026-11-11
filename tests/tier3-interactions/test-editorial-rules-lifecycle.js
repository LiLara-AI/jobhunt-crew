'use strict';
/**
 * Tier 3: Cross-Feature Interactions - Self-Learning Editorial Rules Lifecycle
 * Verifies capturing approved user corrections into traceable rules,
 * applying active rules to subsequent drafts, and clean undo behavior.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { TestSuite } = require('../helpers/test-harness');

const { EditorialRuleEngine } = require('../../lib/honest-cv/editorial-rules');

const suite = new TestSuite('Tier 3: Self-Learning Editorial Rules');

suite.test('Editorial rule learned from user correction applies to subsequent text', assert => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-ed-'));
  const engine = new EditorialRuleEngine({ workspaceDir });

  // User corrects buzzword 'synergized cross-team efforts' to 'orchestrated multi-squad architecture reviews'
  engine.learnRuleFromCorrection(
    'rule_01',
    'synergized cross-team efforts',
    'orchestrated multi-squad architecture reviews',
    'Candidate prefers concrete architectural verb over generic corporate jargon'
  );

  const initialDraft = 'At Apex, the candidate synergized cross-team efforts across 2 platform squads.';
  const editedDraft = engine.applyRules(initialDraft);

  assert.equal(editedDraft, 'At Apex, the candidate orchestrated multi-squad architecture reviews across 2 platform squads.');
  assert.equal(editedDraft.includes('synergized'), false);
});

suite.test('Undoing an editorial rule cleanly restores original drafting behavior', assert => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-ed-'));
  const engine = new EditorialRuleEngine({ workspaceDir });

  engine.learnRuleFromCorrection(
    'rule_02',
    'utilized',
    'leveraged',
    'Preferred vocabulary'
  );

  const draftText = 'Utilized Go and Kafka for event streaming.';
  assert.equal(engine.applyRules(draftText), 'leveraged Go and Kafka for event streaming.');

  // Undo rule
  engine.undoRule('rule_02');
  assert.equal(engine.applyRules(draftText), draftText, 'Text must remain untouched when rule is undone');
});

module.exports = suite;
if (require.main === module) {
  suite.run({ verbose: true });
}
