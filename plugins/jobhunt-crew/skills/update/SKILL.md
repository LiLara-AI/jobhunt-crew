---
name: update
description: "Updates an existing JobHunt Crew profile and workspace. Use when the user wants to add or correct an achievement, job, or skill, confirm pending facts, change target titles, cities, or salary floor, or teach a wording preference for future drafts."
---


# Update — Refresh an Existing Workspace

Use when the user wants to update their profile, add a new achievement, correct a
drafting preference, change targets, or bring workspace state back in sync.

## Steps

1. **Load current state.** Read `.crew/snapshot.json` via MCP `crew_get_snapshot`
   and note stale applications and pending decisions. Open `[CONFIRM]` items
   are not in the snapshot: read them from `dossier.json` (claims whose
   `status` is `CONFIRM`).
2. **Replay before editing.** Run `crew ledger replay` so the snapshot
   reflects every recorded event. Never edit `snapshot.json` by hand.
3. **Apply the requested change, one topic at a time:**
   - New or corrected career facts: add them to `dossier.json` as new `[C-xx]`
     claims in the shape of the existing ones (`id`, `employerId` of an
     existing `employers[]` entry, `text`, `metrics[]`, `tools[]`) with
     `"status": "CONFIRM"`. Never omit `status`: a claim without it counts as
     verified. Read the claim back; once the user confirms the exact wording,
     employer, and metric, call `crew_confirm_claims` with its id (CLI
     `crew claim confirm --id <ids>`). Never set `VERIFIED` by hand. For a
     correction, change the existing claim in place and set its `status` back
     to `CONFIRM`; a wrong claim left as verified stays usable in drafts.
   - Target changes (titles, cities, countries, knockouts, watchlist): edit
     `search-config.json`, which job scoring reads and which overrides
     `preferences` in `dossier.json` (edit those only when the workspace has no
     `search-config.json`). The salary floor and its disclosure policy live in
     `dossier.json` under `candidate.salaryFloor`. Then record a ledger event
     with `crew_record_event` describing what changed and why.
   - Drafting preferences ("never say X", "prefer Y phrasing"): teach the
     editorial engine instead of hard-coding them into prompts. Use MCP
     `crew_editorial_rules` with action `learn` (backed by
     `EditorialRuleEngine.learnRuleFromCorrection` in
     `lib/honest-cv/editorial-rules.js`). List rules with action `list`, preview
     with action `apply`, and revert a bad rule with action `undo`.
4. **Re-verify affected drafts.** If a claim changed, re-run MCP
   `crew_verify_draft` on any live draft that cites it. Drafts that now fail go
   back to the Scribe queue, not forward to packaging.
5. **Health check and backup.** Run `crew_doctor`. After a significant update,
   offer a backup via MCP `crew_backup` (CLI `crew backup`).
6. **Summarize.** Report claims added or changed, rules learned, drafts sent back
   for rework, and what still waits on `[CONFIRM]`.

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

- MCP: `crew_get_snapshot`, `crew_confirm_claims`, `crew_record_event`,
  `crew_editorial_rules`, `crew_verify_draft`, `crew_doctor`, `crew_backup`
- CLI: `crew ledger replay`, `crew claim confirm`, `crew backup`, `crew doctor`
