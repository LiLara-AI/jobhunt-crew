# JobHunt Crew — Operating Rules

These rules bind every agent, skill, and tool call in this plugin, on every host
(Claude Code and Cowork, Gemini CLI and Extensions, Gemini Desktop, Antigravity).
When a request conflicts with a rule below, the rule wins and the conflict is
reported to the user instead of being worked around.

## 1. 100% Local File State

- All state lives in local files inside the user's workspace:
  - `.crew/ledger.jsonl` — append-only event ledger (source of truth)
  - `.crew/snapshot.json` — materialized view rebuilt from the ledger
  - `dossier.json` — candidate profile with claim-tagged evidence
  - `Applications/` — generated application packs
- Never send workspace state to a remote database or third-party store.
- State changes go through ledger events (MCP `crew_record_event` or the CLI),
  never by hand-editing `snapshot.json`.

## 2. Strict Human-in-the-Loop Submission

- No agent submits a job application. Ever.
- An `APPLICATION_SUBMITTED` event is valid only with actor `human` and a
  non-empty authorization token; the guardrail engine rejects anything else.
- Browser assistance stops at `ready-to-submit`: fields may be pre-filled, the
  final review and submit click belong to the human.
- Outreach and follow-up messages are drafts for the human to send.

## 3. Deterministic Claim Verification

- Every employer, title, date, metric, and credential in generated text must
  trace to a dossier claim tagged `[C-xx]`.
- Drafts pass the deterministic verifier (`lib/honest-cv/verify-claims.js`,
  MCP `crew_verify_draft`, CLI `crew claim`) before packaging.
- Anything the verifier cannot confirm is marked `[CONFIRM]` and blocks the
  pack until the candidate confirms or removes it.
- Never invent, round up, or re-attribute a claim to a different employer.

## 4. Zero Age Penalty for Open Vacancies

- Posting age never lowers a score and never closes a vacancy.
- A role closes only on evidence: HTTP 404/410, an explicit closure notice, a
  passed stated deadline, or a direct rejection (MCP `crew_close_job`).

## 5. Optimal Task-Specific Model Routing

Route work to the cheapest tier that can do it correctly:

| Agent | Tier | Owns |
| --- | --- | --- |
| Dispatcher | Flash | Queue inspection, waking agents, daily briefing |
| Recon | Flash | Discovery sweeps, dedup, rubric triage |
| Liaison | Flash | Inbox signals, 7/14-day cadence, outreach drafts |
| Navigator | Flash | Browser session health, attended pre-fill checks |
| Scribe | Pro | CV and cover-letter tailoring, apply packs |
| Inquisitor | Pro | Claim verification gating, keyword-gap analysis |
| Critic | Pro | Candidate-isolated blind review panel |

Escalate to Pro only for drafting, verification judgement, and review.
Keep high-volume scanning and bookkeeping on Flash.

## Privacy

- Respect `.pii-denylist`: strings listed there never appear in generated
  files, commits, or tool output meant for sharing.
- Blind review payloads are scrubbed of candidate identity before the Critic
  sees them (`lib/honest-cv/review-panel.js`).

## Running the engine on any host

The engine is plain Node.js 18+ with no dependencies. Two folders matter:

- **Plugin root**: the folder holding `bin/`, `lib/`, `skills/`, and this file.
  In Claude Code and Cowork it is `${CLAUDE_PLUGIN_ROOT}`. Treat it as
  read-only: it can be replaced on every plugin update.
- **Workspace**: the user's job-hunt folder holding `.crew/`, `dossier.json`,
  and `applications/`. In Cowork this is the folder the user connected.
  Always pass it as `--workspace "<folder>"` (or set `CREW_WORKSPACE`).

Every `crew_*` tool can be called in one of two ways:

1. As an MCP tool, when the host has the `crew` server registered.
2. Through the CLI bridge, which runs the same handler:
   `node "<plugin root>/bin/crew.js" tool <crew_tool_name> --workspace "<folder>" --args '<json>'`
   Use `--args-file <path>` for long JSON or shells that mangle quotes
   (PowerShell, cmd). `node "<plugin root>/bin/crew.js" tool list` prints every
   tool and its arguments.

Lifecycle commands have no MCP tool and use the CLI directly: `init`,
`doctor`, `ledger replay`, `ledger append`, `claim verify`, `export`, `ui`.

Host setup (MCP registration for Claude Desktop, Codex, Kimi, ChatGPT) is in
`docs/hosts.md`.
