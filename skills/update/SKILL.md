---
name: update
description: "Refreshes an existing JobHunt Crew workspace: replays the ledger, updates dossier claims, learns editorial rules from corrections, and re-checks health."
---

# Update — Refresh an Existing Workspace

Use when the user wants to update their profile, add a new achievement, correct a
drafting preference, change targets, or bring workspace state back in sync.

## Steps

1. **Load current state.** Read `.crew/snapshot.json` via MCP `crew_get_snapshot`
   and note open `[CONFIRM]` items, stale applications, and pending decisions.
2. **Replay before editing.** Run `node bin/crew.js ledger replay` so the snapshot
   reflects every recorded event. Never edit `snapshot.json` by hand.
3. **Apply the requested change, one topic at a time:**
   - New or corrected career facts: add them to `dossier.json` as new `[C-xx]`
     claims. New claims start unverified and are shown to the user as `[CONFIRM]`
     until they confirm the exact wording, employer, and metric.
   - Target changes (titles, cities, salary floor, knockouts): update the dossier
     preferences, then record a ledger event with `crew_record_event` describing
     what changed and why.
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

## Tool reference

- MCP: `crew_get_snapshot`, `crew_record_event`, `crew_editorial_rules`,
  `crew_verify_draft`, `crew_doctor`, `crew_backup`
- CLI: `crew ledger replay`, `crew claim`, `crew backup`, `crew doctor`
