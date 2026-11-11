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
   role or team. If no verified claim fits, write a claim-free note instead of
   stretching one.
3. **Generate the draft.** Use MCP `crew_outreach`, backed by
   `OutreachGenerator.generateOutreach` in `lib/crew/outreach.js` (with
   `getCharCount` and `fitWithinLimit` enforcing the limit). For InMail or email
   follow-ups, the 300-character cap does not apply, but keep it to a short
   paragraph plus one clear ask.
4. **For follow-ups, check cadence first.** If the message follows a submitted
   application, check MCP `crew_cadence` so the note lands on the day-7 or
   day-14 touchpoint instead of nagging early.
5. **Present 2 variants** (direct and warmer), each with its character count and
   the claim id used. Let the user pick or edit; record a sent follow-up only
   when the user confirms they sent it, via `crew_record_event`.

## What never goes in a note

Salary numbers, unverified metrics, current-employer confidential details, or
anything listed in `.pii-denylist`.

## Tool reference

- MCP: `crew_outreach`, `crew_cadence`, `crew_get_job`, `crew_record_event`
- CLI: `crew alerts`, `crew job inspect`
