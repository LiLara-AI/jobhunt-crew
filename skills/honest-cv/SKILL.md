---
name: honest-cv
description: "End-to-end claim-verified CV and cover letter tailoring pipeline with blind review panel and attended browser form pre-filling stopping before submit."
---

# Honest-CV — Claim-Verified Application Pipeline

Use when the user says apply to this job, tailor my CV, write a cover letter for
this posting, or pastes a job description and wants application materials.

## Hard boundaries

- Every fact in the draft traces to a verified `[C-xx]` dossier claim.
- Unverified material is marked `[CONFIRM]` and blocks packaging.
- The pipeline ends at `ready-to-submit`. Only the human submits.

## The 8 stages

1. **Intake and positioning.** Read the posting (pasted text, URL, or a job in the
   snapshot via MCP `crew_get_job`). Extract must-have requirements, seniority,
   and location terms. State the honest positioning angle in one sentence.
2. **Claim grounding.** From `dossier.json`, select only claims whose employer,
   dates, and metrics support this role. List the chosen `[C-xx]` ids before
   drafting so gaps are visible early.
3. **Drafting (Scribe, Pro tier).** Write the tailored CV and cover letter using
   only the grounded claims, in the candidate's own voice. Apply learned
   preferences with MCP `crew_editorial_rules` action `apply`. Documents can be
   rendered with `lib/honest-cv/doc-generator.js` (`DocGenerator.generateCvDocx`,
   `generateCvPdf`, `generateCoverLetterDocx`).
4. **Human-voice pass.** Remove generic filler, inflated adjectives, and any
   sentence that could belong to any candidate. Shorten before decorating.
5. **Blind review (Critic, Pro tier).** Run the candidate-isolated panel:
   MCP `crew_blind_review` (backed by `BlindReviewPanel.evaluate` and
   `DualPersonaEvaluator` in `lib/honest-cv/review-panel.js`). The payload is
   scrubbed of identity and claim ids first (`CandidateScrubber.scrubAll`), then
   scored from Recruiter and Hiring Manager perspectives. `REQUEST_CHANGES`
   sends the draft back to stage 3 with the panel's top recommendations.
6. **Deterministic verification (Inquisitor).** Run MCP `crew_verify_draft`
   (CLI `crew claim`) against the dossier. This calls
   `ClaimVerifier.verifyDraft` in `lib/honest-cv/verify-claims.js`. Any violation
   (unknown metric, wrong employer, missing claim) must be fixed or explicitly
   confirmed by the candidate. No pack is built on a failed verification.
7. **Stage 7 apply pack.** Build the pack with MCP `crew_apply_pack`, backed by
   `ApplyPackGenerator` in `lib/honest-cv/apply-pack.js`
   (`generateScreeningAnswers`, `buildPreFillPlan`, `compileApplyPackMarkdown`,
   `writeApplyPack`). Output lands in `applications/` as `apply-pack.md` with the
   claim manifest, review verdict, screening answers that respect the salary
   disclosure policy, and the pre-fill plan whose safety gate is validated by
   `validateSafetyGate`.
8. **Attended pre-fill.** In the browser, fill fields per the pre-fill plan and
   stop. Status stays `ready-to-submit`. Record progress with
   `crew_record_event`; the human reviews, attaches files, and submits. An
   `APPLICATION_SUBMITTED` event is only ever recorded by the human with an
   authorization token.

## If verification fails

Show the exact violating sentences, the claim they needed, and the two honest
options: reword to match the dossier, or confirm a corrected claim through the
update skill. Never silently soften numbers to make the check pass.

## Running the engine

Read the operating rules in `${CLAUDE_PLUGIN_ROOT}/rules/AGENTS.md` first; they
override this skill.

The steps name `crew_*` tools. Call them as MCP tools when this session has
them. Otherwise run the same tool through the bundled CLI (Node 18+):

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/crew.js" tool <crew_tool_name> --workspace "<job-hunt folder>" --args '<json arguments>'
```

- `crew <command>` in this skill means
  `node "${CLAUDE_PLUGIN_ROOT}/bin/crew.js" <command> --workspace "<job-hunt folder>"`.
- The job-hunt folder is the user's folder that holds `.crew/` and `dossier.json`
  (in Cowork, the folder the user connected). Never use the plugin folder: it
  can be read-only and is replaced on every update.
- `crew tool list` prints every tool and its arguments. For long or quoted
  JSON, write it to a file and pass `--args-file <path>` instead of `--args`.
- If `${CLAUDE_PLUGIN_ROOT}` appears literally (hosts other than Claude), use
  the plugin root instead: the folder that contains `skills/` and `lib/`.

## Tool reference

- MCP: `crew_get_job`, `crew_editorial_rules`, `crew_blind_review`,
  `crew_verify_draft`, `crew_apply_pack`, `crew_record_event`
- CLI: `crew claim`, `crew review`, `crew job inspect`, `crew ledger replay`
