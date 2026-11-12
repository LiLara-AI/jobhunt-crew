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
2. **Salary structure.** Action `salary` (`calculateSalaryStructure`) splits the
   package into the standard 65% basic / 25% housing / 10% transport and flags a
   compressed basic, which quietly reduces end-of-service value.
3. **GOSI.** Action `gosi` (`calculateGosi`) computes contributions on basic plus
   housing, capped at the statutory wage cap: 21.5% total for Saudi nationals
   (9.75% employee side), 2% employer-only hazards cover for non-Saudis. Show
   the resulting net take-home.
4. **End-of-service (EOSB).** Action `eosb` (`calculateEosb`) applies Articles
   84/85: half a month per year for the first five years, a full month after,
   with resignation reductions before ten years. Show values at 2, 5, and 10
   years so the basic-salary effect is visible.
5. **Probation and Qiwa.** Probation beyond 90 days needs written agreement and
   may not exceed 180 days (checked inside `evaluateOffer`). Remind the user to
   confirm the contract is the Qiwa-registered version and that title, salary,
   and start date match the offer letter exactly.
6. **Non-compete.** Action `noncompete` (`validateNonCompete`) checks Article 83
   limits: at most 24 months and a defined geographic scope where the employer
   actually operates. Flag worldwide or open-ended wording.
7. **Negotiation summary.** Use action `evaluate` for the combined report, then
   list asks in priority order (raise basic share before gross, narrow the
   non-compete, clarify probation terms) with short, collaborative phrasing the
   user can send. Drafts only; the human negotiates.

## Tool reference

- MCP: `crew_ksa_offer`, `crew_get_job`, `crew_record_event`
- CLI: `crew job inspect`
