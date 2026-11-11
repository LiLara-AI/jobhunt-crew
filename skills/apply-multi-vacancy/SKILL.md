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

## Tool reference

- MCP: `crew_get_snapshot`, `crew_get_job`, `crew_triage_job`,
  `crew_blind_review`, `crew_verify_draft`, `crew_apply_pack`
- CLI: `crew job triage`, `crew job inspect`, `crew claim`
