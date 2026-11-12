---
name: setup
description: "Interactive single-question onboarding wizard that parses your resume, suggests target job titles, and initializes your local job search workspace."
---


# Setup — JobHunt Crew Onboarding

Use when the user wants to start, set up, initialize, or onboard JobHunt Crew,
or when no `dossier.json` / `.crew/` exists in the workspace yet.

## Rules for this skill

- Ask exactly one question per turn. Wait for the answer before continuing.
- Never invent profile facts. Quote the resume back when suggesting titles.
- Everything is written locally. Nothing leaves the workspace.

## Steps

1. **Check the workspace.** Run `node bin/crew.js doctor` (or MCP `crew_doctor`).
   Note whether `.crew/ledger.jsonl`, `dossier.json`, and `.pii-denylist` exist.
   If the workspace is already initialized, ask whether to resume or rebuild.
2. **Get the resume.** Ask for a resume file path or pasted text, one question only.
   Parse employers, titles, dates, and measurable outcomes into draft claims.
3. **Suggest titles.** Present Lateral, Stretch, and Pivot title options, each tied
   to a quoted resume line. Let the user keep, drop, or add titles.
4. **Locations.** Ask country first, then cities (two separate turns). Include
   Remote as an explicit option.
5. **Work mode and salary floor.** Ask allowed modes (on-site, hybrid, remote),
   then the salary disclosure policy: leave blank if optional, mandatory-only
   number, or negotiable placeholder. Store the floor privately in the dossier.
6. **Authorization and notice.** Ask work authorization status and notice period
   as plain facts, with no recommendation attached.
7. **Knockouts.** Ask which sectors, companies, or conditions are hard exclusions.
8. **Boards and watchlist.** Confirm which boards to sweep and which employers to
   watch even when they post rarely.
9. **Initialize.** Run `node bin/crew.js init` for the workspace, then write the
   confirmed profile to `dossier.json`. Tag every stored fact pattern as a claim
   (`[C-01]`, `[C-02]`, ...). Anything the user has not confirmed stays `[CONFIRM]`.
   The intake flow is backed by `lib/honest-cv/intake-wizard.js` (`IntakeWizard`,
   `TitleFinder.generateRecommendations`, `WorkspaceBuilder.build`) and the dossier
   model in `lib/honest-cv/dossier.js` (`CareerDossier.createTemplate`).
10. **Verify and hand off.** Re-run `crew_doctor`, replay the ledger with
    `node bin/crew.js ledger replay`, and summarize: claims stored, titles and
    cities targeted, knockouts recorded, and the next suggested action
    (usually a first discovery sweep).

## Tool reference

- MCP: `crew_doctor`, `crew_record_event`, `crew_get_snapshot`
- CLI: `crew init`, `crew doctor`, `crew ledger replay`
