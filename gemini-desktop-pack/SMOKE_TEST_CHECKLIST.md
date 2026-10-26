# Gemini Desktop Companion — Smoke-Test Checklist

This checklist allows you to quickly verify that your Gemini Desktop Companion is operating properly alongside JobHunt Crew.

---

## Pre-Flight Check
- [ ] Gemini Desktop app is running and logged in.
- [ ] `JobHunt Crew Companion` Gem is installed and instructions from `GEM_SYSTEM_PROMPT.md` are saved.
- [ ] Working directory has initialized `.crew/` and `inbox/proposals/` directories.

---

## 5-Scenario Verification Matrix

### 1. Morning Briefing (Read-Only)
- [ ] Prompt: *"Give me my morning briefing."*
- [ ] Gemini quotes current counts from `.crew/snapshot.json`.
- [ ] `.crew/ledger.jsonl` remains completely unmodified.

### 2. Opportunity Triage Ingestion
- [ ] Instruct Gemini to shortlist a role.
- [ ] Save generated JSON to `<workspace>/inbox/proposals/triage_<jobId>.json`.
- [ ] Run: `node bin/crew.js companion ingest`
- [ ] Verify file moved to `inbox/processed/` and `snapshot.json` reflects `shortlisted`.

### 3. Honest-CV Draft Quarantine (Rule 2)
- [ ] Instruct Gemini to draft a cover letter.
- [ ] Save to `inbox/proposals/draft_<jobId>.json`.
- [ ] Run: `node bin/crew.js companion ingest`
- [ ] Verify output shows `HOLD_FOR_CLAIM_VERIFICATION` and status `pending_inquisitor_verification`.

### 4. Submission Guardrail Block (Rule 1)
- [ ] Place a file in `inbox/proposals/` with `action: "submitted"`.
- [ ] Run: `node bin/crew.js companion ingest`
- [ ] Verify rejection: `GUARDRAIL_VIOLATION` reported, file moved to `inbox/errors/`, error sidecar created.
- [ ] Verify application status did NOT change to `submitted`.

### 5. Malformed JSON Recovery
- [ ] Place truncated JSON in `inbox/proposals/broken.json`.
- [ ] Run: `node bin/crew.js companion ingest`
- [ ] Verify file moved to `inbox/errors/broken.<time>.malformed.json`.
- [ ] Verify ledger and snapshot remain 100% clean (`stateCorrupted: false`).

---

## Automated Verification Suite
To run the automated suite exercising all 5 scenarios:
```bash
node tests/tier1-feature-coverage/test-gemini-companion.js
node tests/tier2-boundary-corners/test-m7-adversarial-companion.js
```
*Expected Result*: All tests pass with 0 failures.
