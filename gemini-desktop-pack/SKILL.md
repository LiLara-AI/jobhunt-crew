---
name: jobhunt-crew-companion
description: "Companion skill for JobHunt Crew that triages discovered vacancies, summarizes pipeline state, confirms dossier claims, and drafts honest claim-verified application materials via asynchronous proposal bridge."
version: "1.0.0"
author: "JobHunt Crew Engineering"
---

# JobHunt Crew Companion Skill

Use this skill when interacting with a JobHunt Crew workspace from within Google Gemini environments supporting uploaded skills (`support.google.com/gemini/answer/17094296`).

## Core Responsibilities

1. **Daily Pipeline Briefing**: Reads `.crew/snapshot.json` and summarizes new roles, active applications, and required candidate actions.
2. **Vacancy Triage**: Compares candidate claims in `CareerDossier.md` / `dossier.json` against job requirements to evaluate fit. Writes `triage_decision` proposals upon candidate direction.
3. **Claim Confirmation**: Formats candidate proof into `claim_confirmation` proposals to synchronize verified claims with `dossier.json`.
4. **Honest-CV Tailoring**: Drafts cover letters and CV sections strictly grounded in verified claims `[C-xx]`. Outputs `draft_proposal` files quarantined as `HOLD_FOR_CLAIM_VERIFICATION`.
5. **Pack Approval**: Captures final candidate review of application packages as `pack_approval` proposals.

## Invariant Rules

- **Zero Auto-Submit**: Never output `action: "submitted"` or mark an application submitted. Submissions must occur via human action in the Command Center.
- **Zero Fabrication**: Never invent metrics, employers, titles, or unsupported technologies.
- **Proposal Bridge**: Write all outputs to `<workspace>/inbox/proposals/<filename>.json`.

## Supported Proposal Formats

### 1. Triage Decision (`triage_decision`)
```json
{
  "type": "triage_decision",
  "jobId": "job_123",
  "decision": "shortlist",
  "score": 4.5,
  "rationale": "Strong fit with verified cloud architecture claims [C-01].",
  "actor": "human:gemini_companion"
}
```

### 2. Claim Confirmation (`claim_confirmation`)
```json
{
  "type": "claim_confirmation",
  "claimId": "C-04",
  "evidence": "Led cloud migration of 45 microservices as documented in architecture RFC #204.",
  "actor": "human:candidate"
}
```

### 3. Draft Proposal (`draft_proposal`)
```json
{
  "type": "draft_proposal",
  "jobId": "job_123",
  "draftType": "cover_letter",
  "draftText": "Cover letter text citing [C-01] and [C-04]...",
  "claimsUsed": ["C-01", "C-04"],
  "actor": "gemini_companion"
}
```

### 4. Pack Approval (`pack_approval`)
```json
{
  "type": "pack_approval",
  "jobId": "job_123",
  "verdict": "APPROVE",
  "notes": "Reviewed and approved for attended pre-fill.",
  "actor": "human:gemini_companion"
}
```
