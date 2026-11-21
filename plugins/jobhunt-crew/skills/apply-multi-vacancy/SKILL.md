---
name: apply-multi-vacancy
description: "Handles several openings at one employer: recommends apply or skip per role, then builds one shared CV with a cover letter per role. Use instead of honest-cv when the user wants to apply to two or more roles at the same company, or asks which of a company's postings to pursue."
---


# Apply Multi-Vacancy — Several Roles, One Employer

Use when the user wants to apply to multiple openings at the same company, or
asks which of a company's postings they should pursue.

## Why this needs its own flow

Enterprise applicant systems often keep one candidate profile per company.
Sending divergent CVs to sibling requisitions creates contradictions recruiters
can see. This skill produces one convergent narrative plus role-specific cover
letters. No tool does the apply-or-skip triage for you: you do it in step 2.

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
   relevant to all chosen roles, then draft the one shared CV (the honest-cv
   skill, `skills/honest-cv/SKILL.md` in the plugin root, has the drafting
   stages). Checks are stored per job and the review is scored against one
   role's requirements, so repeat them for every APPLY role: run
   `crew_verify_draft` on the CV with that role's `job_id`, run
   `crew_blind_review` with that role's title and requirements, and record
   that role's own verdict with `crew_review_record`. Never record one role's
   verdict for another. A role without both shows NOT RUN in its pack and its
   submit is refused. A posting that is
   not tracked yet is added first with `crew job add --url <u> --title <t>
   --company <c>`; read its id from `crew_get_snapshot`.
4. **Per-role cover letters.** Each APPLY role gets its own letter with its own
   focus area and salutation, while facts and metrics stay identical to the
   convergent CV. Verify each letter with `crew_verify_draft` and that role's
   `job_id`; only the latest result per job is kept, so finish each role on a
   pass.
5. **Package per role.** Run `crew_apply_pack` once per APPLY role with that
   role's `job_id`, the same `claims_used` list so every pack renders the
   same CV content, and that role's letter as `cover_letter_text`. A pack is
   ready only when its result has `status` `ready-to-submit` and an empty
   `blockers` list. The tool has no
   field that links packs: tell the user which
   packs share the CV before they submit anything.
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

- MCP: `crew_get_snapshot`, `crew_get_job`, `crew_blind_review`,
  `crew_review_record`, `crew_verify_draft`, `crew_apply_pack`
- CLI: `crew job add`, `crew job inspect`
