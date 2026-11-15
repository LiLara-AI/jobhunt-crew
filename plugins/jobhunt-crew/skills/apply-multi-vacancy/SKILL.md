---
name: apply-multi-vacancy
description: "Evaluates several openings at one employer, recommends apply or skip per role, and builds one convergent CV with per-role cover letters."
---


# Apply Multi-Vacancy — Several Roles, One Employer

Use when the user wants to apply to multiple openings at the same company, or
asks which of a company's postings they should pursue.

## Why this needs its own flow

Enterprise applicant systems often keep one candidate profile per company.
Sending divergent CVs to sibling requisitions creates contradictions recruiters
can see. This skill produces one convergent narrative plus role-specific cover
letters, backed by `MultiVacancyStrategist.evaluateCompanyVacancies` in
`lib/honest-cv/multi-vacancy.js`.

## Steps

1. **Collect the vacancies.** Gather each posting's id, title, level, department,
   and requirements text (from the snapshot via `crew_get_snapshot` /
   `crew_get_job`, or pasted by the user).
2. **Triage apply vs skip.** Evaluate seniority and domain fit per vacancy.
   Roles below the candidate's target seniority or outside their specialization
   get an explicit SKIP with the reason stated; the rest get APPLY. Show this
   table to the user and let them override before drafting anything.
3. **Build the convergent CV.** One headline and one core claim set must serve
   every APPLY role. Choose bridging claims (verified `[C-xx]` only) that are
   relevant to all chosen roles, then run the honest-cv drafting, blind review,
   and verification stages once for this shared CV.
4. **Per-role cover letters.** Each APPLY role gets its own letter with its own
   focus area and salutation, while facts and metrics stay identical to the
   convergent CV. Verify each letter with `crew_verify_draft`.
5. **Package per role.** Run `crew_apply_pack` once per APPLY role, all pointing
   at the same convergent CV artifact. Record the shared-CV relationship in each
   pack so the human sees the linkage before submitting anything.
6. **Order the submissions.** Recommend a submission order (strongest fit first)
   and remind the user that each final submit is theirs, one role at a time.

## Running the engine

Read the operating rules in `${CLAUDE_PLUGIN_ROOT}/rules/AGENTS.md` first; they
override this skill.

The steps name `crew_*` tools. Call them as MCP tools when this session has
them. Otherwise run the same tool through the bundled CLI (Node 18+):

```bash
node "${CLAUDE_PLUGIN_ROOT}/cli/crew.js" tool <crew_tool_name> --workspace "<job-hunt folder>" --args '<json arguments>'
```

- `crew <command>` in this skill means
  `node "${CLAUDE_PLUGIN_ROOT}/cli/crew.js" <command> --workspace "<job-hunt folder>"`.
- The job-hunt folder is the user's folder that holds `.crew/` and `dossier.json`
  (in Cowork, the folder the user connected). Never use the plugin folder: it
  can be read-only and is replaced on every update.
- `crew tool list` prints every tool and its arguments. For long or quoted
  JSON, write it to a file and pass `--args-file <path>` instead of `--args`.
- If `${CLAUDE_PLUGIN_ROOT}` appears literally (hosts other than Claude), use
  the plugin root instead: the folder that contains `skills/` and `lib/`.

## Tool reference

- MCP: `crew_get_snapshot`, `crew_get_job`, `crew_triage_job`,
  `crew_blind_review`, `crew_verify_draft`, `crew_apply_pack`
- CLI: `crew job triage`, `crew job inspect`, `crew claim`
