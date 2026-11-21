---
name: interview-prep
description: "Interactive mock interview simulator and STAR plus R story bank companion tied to verified candidate claims with cultural and company signal analysis."
---

# Interview Prep — One Question at a Time

Use when the user has an interview coming up, wants mock practice, or wants to
build and rehearse behavioral stories.

## Interaction contract

- Ask exactly one interview question per turn. Wait for the spoken-style answer.
- Score each answer before moving on: structure, evidence, and clarity.
- Stories use STAR+R: Situation, Task, Action, Result, Reflection.
- Every metric in a story must match its bound `[C-xx]` claim.

## The 3 archetypes

Run the simulation in the archetype the user picks (default order below):

1. **Recruiter screen** — motivation, logistics, salary-policy-safe answers,
   notice period, authorization. Keep answers under two minutes.
2. **Hiring manager** — depth on past systems, trade-offs, failure handling.
   Push for the decision and the number, not just the activity.
3. **Executive** — business impact, prioritization, leadership scope. Answers
   lead with outcomes and cost or risk framing.

## Steps

1. **Load context.** Fetch the role with `crew_get_job` if it is tracked, and
   read the dossier claims most relevant to its requirements.
2. **Build or refresh the story bank.** Use MCP `crew_interview_story`, backed by
   `StarRStoryBank` in `lib/crew/interview-story-bank.js`. Action `list` shows
   confirmed stories; action `add` validates a new story's STAR+R fields and
   claim binding (`validateStory` rejects unbound claims, employer mismatches,
   and metrics not declared on the claim). Stories bound to unconfirmed claims
   stay in draft status and are excluded from packs.
3. **Run the mock.** One question, one answer, one rubric score:
   - Structure (STAR+R complete and in order)
   - Evidence (metric present and claim-accurate)
   - Clarity (answer lands in about two minutes)
   Give the single highest-value fix, then offer a retry of the same question.
4. **Generate the pack.** Action `pack` on `crew_interview_story` compiles the
   interview pack (`generateInterviewPack`): mapped stories, anticipated
   questions, and reverse-interview questions for the candidate to ask.
5. **Close with gaps.** Name requirement areas with no confirmed story and route
   the user to the update skill to confirm the missing claims honestly.

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

- MCP: `crew_interview_story`, `crew_get_job`, `crew_get_snapshot`
- CLI: `crew job inspect`, `crew claim verify`
