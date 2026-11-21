---
name: contacto
description: "Drafts concise under 300 character outreach notes and follow-up messages for recruiters, hiring managers, and peers anchored in verified dossier claims."
---


# Contacto — Short, Honest Outreach Drafts

Use when the user wants a LinkedIn connection note, an InMail, a recruiter
follow-up, or a peer introduction message.

## Constraints

- LinkedIn connection notes stay at or under 300 characters. Count characters
  and show the count with every draft.
- One verified claim at most per note, cited by its result, never inflated.
- Drafts only. The human copies, edits, and sends. Nothing is auto-sent.

## Steps

1. **Identify the recipient type**: `RECRUITER` (fit and availability),
   `HIRING_MANAGER` (relevant delivered impact), or `PEER` (shared technical
   ground). Ask one question if the type or target role is unclear.
2. **Pick the claim.** Choose a single verified `[C-xx]` claim relevant to the
   role or team and pass its id as `claim_id`. If no verified claim fits, write
   a claim-free note instead of stretching one: pass `claim_id` `"none"`,
   because with no `claim_id` the tool picks the first verified claim itself.
3. **Generate the draft.** Use MCP `crew_outreach`, backed by
   `OutreachGenerator.generateOutreach` in `lib/crew/outreach.js` (with
   `getCharCount` and `fitWithinLimit` enforcing the limit). The `RECRUITER`
   draft says the user recently applied: reword that sentence if they have not.
   For InMail or email
   follow-ups, the 300-character cap does not apply, but keep it to a short
   paragraph plus one clear ask.
4. **For follow-ups, check cadence first.** If the message follows a submitted
   application, check MCP `crew_cadence` so the note lands on the day-7 or
   day-14 touchpoint instead of nagging early.
5. **Present 2 variants** (direct and warmer), each with its character count and
   the claim id used. Let the user pick or edit; record a sent follow-up only
   when the user confirms they sent it, via `crew_record_event` with type
   `FOLLOW_UP_SENT` and payload `{ "jobId": "<id>", "day": 7 }` (or `14`), so
   `crew_cadence` stops reporting that touchpoint as due.

## What never goes in a note

Salary numbers, unverified metrics, current-employer confidential details, or
anything listed in `.pii-denylist`.

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

- MCP: `crew_outreach`, `crew_cadence`, `crew_get_job`, `crew_record_event`
- CLI: `crew alerts closing-soon`, `crew job inspect`
