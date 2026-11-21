---
name: offer-review
description: "Evaluates employment contracts and job offers against Saudi Labor Law, calculating end-of-service benefits, salary splits, GOSI, and non-compete clauses."
---


# Offer Review — KSA Contract and Offer Checks

Use when the user receives an offer or contract, or wants to compare offers, in
Saudi Arabia. Calculations come from `KsaOfferCalculator` in
`lib/crew/ksa-offer.js` via MCP `crew_ksa_offer`. This is decision support, not
legal advice; say so once, plainly.

## Steps

1. **Capture the terms.** Monthly gross or basic, allowances, probation length,
   contract type, non-compete terms, notice period, and Saudi-national status
   (GOSI differs). Ask for missing items one at a time; never assume a number.
2. **Salary structure.** If the offer states its own basic, housing, or
   transport, pass them with `total_salary` to action `evaluate` and read
   `structure`: that is the only path that checks the real split and flags a
   compressed basic (under 50% of gross). Action `salary`
   (`calculateSalaryStructure`) takes one figure and always returns the
   standard 65% basic / 25% housing / 10% transport split, so use it only when
   the offer gives a single gross or basic figure, and label the result as an
   assumed split, not the offer's terms. These tools model basic, housing, and
   transport only: if the offer itemizes other fixed monthly allowances (phone,
   education, and so on), leave them out of every figure you pass, including
   `total_salary`, and report them separately. They add to the monthly
   take-home, and the end-of-service figures are a floor because they leave
   them out.
3. **GOSI.** Action `gosi` (`calculateGosi`) computes contributions on basic plus
   housing, capped at the statutory wage cap: 21.5% total for Saudi nationals
   (9.75% employee side), 2% employer-only hazards cover for non-Saudis. Pass
   both `basic` and `housing` from step 2: with `basic` alone the tool counts
   housing as 0. Show the resulting net take-home. For a Saudi national pass `is_saudi_national`
   as boolean `true` to `gosi` and `evaluate`: left out or in any other form,
   the tool computes the non-Saudi case and the net take-home comes out too
   high.
4. **End-of-service (EOSB).** Action `eosb` (`calculateEosb`) applies Articles
   84/85: half a month per year for the first five years, a full month after,
   with resignation reductions before ten years. Pass `monthly_wage` as basic
   + housing + transport from step 2 (the wage `evaluate` uses) so the figures
   match the combined report in step 7. Show values at 2, 5, and 10 years.
5. **Probation and Qiwa.** Probation beyond 90 days needs written agreement and
   may not exceed 180 days (checked inside `evaluateOffer`). Remind the user to
   confirm the contract is the Qiwa-registered version and that title, salary,
   and start date match the offer letter exactly.
6. **Non-compete.** Only when the offer has such a clause. Action `noncompete`
   (`validateNonCompete`) checks two Article 83 limits: at most 24 months, and
   a stated geographic scope that is not worldwide, global, or unlimited. It
   cannot tell where the employer actually operates: compare the scope with
   that yourself, and flag open-ended wording.
7. **Negotiation summary.** Use action `evaluate` for the combined report
   (pass `probation_days` `0` when the offer has no probation), then
   list asks in priority order (raise basic share before gross, narrow the
   non-compete, clarify probation terms) with short, collaborative phrasing the
   user can send. Drafts only; the human negotiates.

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

- MCP: `crew_ksa_offer`, `crew_get_job`, `crew_record_event`
- CLI: `crew job inspect`
