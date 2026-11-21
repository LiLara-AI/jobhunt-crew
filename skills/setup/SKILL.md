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

1. **Check the workspace.** Run `crew doctor` (or MCP `crew_doctor`).
   Note whether `.crew/ledger.jsonl`, `dossier.json`, and `.pii-denylist` exist.
   If the workspace is already initialized, ask whether to resume or rebuild.
2. **Get the resume.** Ask for a resume file path or pasted text, one question only.
   No `crew` command reads a resume: read the file yourself, and if your app
   cannot open that file type (often `.docx` or PDF), ask the user to paste
   the text. Parse employers, titles, dates, and measurable outcomes into draft claims.
   Never fall back to example or template data.
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
   Job scoring applies only excluded companies and the seniority floor on its
   own; tell the user that sector and condition exclusions are recorded and
   applied by you when you triage, not by the score.
8. **Boards and watchlist.** Confirm which boards to sweep and which employers to
   watch even when they post rarely.
9. **Initialize.** Run `crew init` for the workspace (it creates `.crew/` and
   `.pii-denylist` only), then write the profile to `dossier.json` yourself, in
   the exact shape of `templates/CareerDossier.example.json` in the plugin root
   (read it first for the field names, which are the only ones the engine
   reads; never copy its example values): `candidate`,
   `employers[]`, and `claims[]` with `id` (`C-01`, `C-02`, ...), `employerId`
   matching an employer `id`, `text`, `metrics[]`, `tools[]`, and `status`.
   Write every claim with `"status": "CONFIRM"`. Never omit `status`: a claim
   without it counts as verified. Set `candidate.salaryFloor.disclosurePolicy`
   to exactly `leave_blank_if_optional`, `mandatory_only`, or
   `negotiable_placeholder`; any other value prints the salary floor in packs.
   Read each claim back to the user. For the ones they confirm, call
   `crew_confirm_claims` (or `crew claim confirm --id <ids>`). Unconfirmed claims
   fail draft verification, so do not skip this, and never
   confirm a claim the user has not approved in this conversation.
   Write `search-config.json` as well, with exactly these keys, which job
   scoring reads: `targetTitles` (array), `targetLocations`
   (`{ "countries": [], "cities": [], "workModes": [] }`), `knockouts`
   (`{ "excludedCompanies": [], "excludedIndustries": [], "seniorityFloor": "" }`),
   `watchlist` (array), `jobBoards` (array).
10. **Verify and hand off.** Re-run `crew_doctor`, replay the ledger with
    `crew ledger replay`, and summarize: claims stored, titles and
    cities targeted, knockouts recorded, and the next suggested action
    (usually a first discovery sweep).

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

- MCP: `crew_doctor`, `crew_confirm_claims`, `crew_record_event`, `crew_get_snapshot`
- CLI: `crew init`, `crew doctor`, `crew claim confirm`, `crew ledger replay`
