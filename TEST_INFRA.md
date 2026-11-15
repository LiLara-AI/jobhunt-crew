# Test Infrastructure Specification: JobHunt Crew

**Target Workspace**: the repository root (`jobhunt-crew/`)  
**Execution Command**: `node tests/e2e-runner.js` (or `npm test`)  
**Design Methodology**: Opaque-box, requirement-grounded, zero-external-dependency test harness.

---

## 1. Overview & Architectural Principles

The JobHunt Crew test infrastructure is designed to provide independent, deterministic, and progressive verification of the entire JobHunt Crew multi-agent system.

### Key Pillars
1. **Zero External Dependencies**: All runners, assertions, mock servers, and fixtures rely exclusively on Node.js built-ins (`fs`, `path`, `http`, `crypto`, `child_process`, `os`).
2. **Deterministic & Isolated**: Every test suite sets up its own state, isolates temporary directories with unique prefixes, and cleans up after itself.
3. **Four-Tier Verification Matrix**:
   - **Tier 1: Feature Coverage** (Core ledger, guardrails, verifier, blind review, doc generation, discovery adapters, crew dispatch, command center, companion).
   - **Tier 2: Boundary & Corner Cases** (Vacancy age limits up to 365d, concurrent atomic writes, malformed JSONL recovery, rate-limit backoff, canonical dedup edge cases).
   - **Tier 3: Cross-Feature Interactions** (Discovery to triage, tailor-verify-review-ready cycle, multi-vacancy strategy, self-learning editorial rules, duplicate application guards).
   - **Tier 4: Real-World Scenarios** (Full 12-stage job search lifecycle simulation, backup/restore byte equality, clean-room 0-shingle scan, and zero-PII audit).
4. **Clean-Room & Zero-PII Enforcement**:
   - Fully integrated with `clean-room-check.js` enforcing $\le 10$ total shingles and $\le 3$ per file against restricted repositories.
   - Audits all files against a local gitignored `.pii-denylist`.

---

## 2. Test Architecture Tiers

### Tier 1: Feature Coverage (Category-Partition Testing)
Covers the core functional surface and interface contracts defined in `PROJECT.md`:
- `test-core-ledger.js`: Monotonic sequencing, ISO UTC timestamps, SHA-256 hash chaining, pure reducer snapshot projection, and replay idempotency.
- `test-guardrails.js`: HumanSubmitGuard (blocks automated agents from submitting), EvidenceClosureGuard (bans age penalties, requires HTTP 404/410, explicit closure, or deadline), ReadinessGate (requires verifier and review panel pass), and CanonicalDedup.
- `test-honest-cv-verifier.js`: Evaluates the 42-case Golden Corpus against candidate claims, verifying metric accuracy, tool verification, employer binding, and credential validation.
- `test-blind-review.js`: Audits the Critic review payload to guarantee strict candidate profile and claim ID isolation.
- `test-doc-generator.js`: Validates binary PDF structure (`%PDF-`, `%%EOF`), OpenXML DOCX envelopes, and native Arabic RTL properties (`<w:bidi/>`, right-aligned justification).
- `test-discovery-adapters.js`: Evaluates Greenhouse, Lever, Ashby, Workday, and SmartRecruiters adapters against recorded HTTP fixtures, and enforces KSA Saudization and scam detection.
- `test-crew-dispatch.js`: Validates 7-agent crew topology, optimal Gemini model routing (Flash for bulk, Pro for reasoning), work-state waking, and Antigravity Scheduled Task `sidecar.json` schemas.
- `test-command-center.js`: Verifies local 127.0.0.1 binding, bearer token authentication (HTTP 401 without token), REST decision endpoints, and 100% offline export capability.
- `test-gemini-companion.js`: Evaluates asynchronous proposal bridge (`inbox/proposals/`), rejecting unauthorized submissions and holding drafts for Inquisitor verification.

### Tier 2: Boundary Value Analysis & Stress
Covers extreme conditions, concurrency, and failure recovery:
- `test-vacancy-age-boundary.js`: Verifies open vacancies remain 100% eligible regardless of posting age (0d, 30d, 60d, 90d, 120d, 365d) with zero score penalties.
- `test-concurrent-writers.js`: Stresses atomic lockfile (`ledger.lock` with `wx` flag and PID lease) with 4 concurrent asynchronous writers logging 40 events simultaneously, asserting 0 corrupted records, 0 lost events, and contiguous sequencing.
- `test-empty-and-malformed.js`: Tests empty files, truncated lines, trailing garbage, and malformed JSON syntax, verifying recovery of preceding valid events without data loss.
- `test-rate-limit-backoff.js`: Simulates HTTP 429 Too Many Requests, exponential backoff, and degraded source alerting.
- `test-dedup-edge-cases.js`: Normalizes messy tracking queries (`utm_*`, `gh_src`, `ref`, session hashes), case variations, trailing slashes, and prevents false collisions between distinct requisitions.

### Tier 3: Cross-Feature Interactions (Pairwise Combinations)
Tests state handoffs across architectural boundaries:
- `test-discovery-to-triage.js`: Multi-channel discovery -> deduplication -> 5-dimension rubric scoring -> triage ledger event.
- `test-tailor-verify-review-cycle.js`: User selection -> Scribe draft -> Inquisitor claim verification -> Critic blind review -> Gate approval -> Ready state -> attended pre-fill -> human submit.
- `test-multi-vacancy-strategy.js`: Company with multiple roles -> apply/skip recommendations with explicit reasoning, 1 convergent CV, and distinct per-role cover letters.
- `test-editorial-rules-lifecycle.js`: Human correction -> editorial rule learned -> applied to subsequent drafts -> undo cleanly restores baseline.
- `test-duplicate-application-guard.js`: Blocks duplicate submissions to same requisition ID, and provides company cooldown warnings.

### Tier 4: Real-World Scenarios & Security
Simulates end-to-end user workflows and environmental compliance:
- `test-full-job-search-lifecycle.js`: Complete 12-stage simulation (Onboarding, Discovery, Triage, Selection, Tailoring, Verification, Blind Review, Ready Gate, Attended Pre-Fill, Human Submit, 7d/14d Follow-up Cadence, KSA Offer Calculation).
- `test-backup-restore-lifecycle.js`: Full state backup -> catastrophic wipe -> restoration -> 100% byte and event equality check.
- `test-clean-room-and-pii.js`: Runs `clean-room-check.js scan jobhunt-crew` ($\le 10$ total shingles, $\le 3$ per file), checks absence of prohibited legacy tokens, and audits against `.pii-denylist`.

---

## 3. Fixtures Architecture

### 3.1 42-Case Golden Corpus (`tests/fixtures/golden-corpus/corpus.json`)
The Golden Corpus contains 42 benchmark cases:
- **21 Clean Drafts**: Exact claim restatements, conservative paraphrases, multi-claim combinations, and qualitative syntheses.
- **21 Planted Fabrications**:
  - `METRIC_INFLATION`: p99 latency cut to 10ms (verified 42ms), savings inflated to $2.5M (verified $480k), compute cut by 75% (verified 34%), throughput inflated to 500k RPS (verified 14k).
  - `UNSUPPORTED_TOOL`: Terraform & Ansible, Apache Spark & PyTorch, AWS Lambda & DynamoDB.
  - `TRANSPLANTED_EMPLOYER`: Attributing payment gateway to Apex Cloud instead of Strata Data, or Istio to Nova Soft.
  - `AUTHORSHIP_INFLATION`: Claiming sole creation of platform code or inventing Kafka consensus.
  - `UNTAGGED_METRIC`: Unverified $12M revenue boost, unverified 80% CI/CD reduction.
  - `SCOPE_INFLATION`: Mentoring 8 engineers inflated to directing division of 120 engineers; Principal Architect inflated to CTO with $50M budget.
  - `FABRICATED_CREDENTIAL`: AWS Certified Solutions Architect Professional, Google Cloud Fellow.
  - `FABRICATED_DEGREE`: Executive MBA from INSEAD.
  - `FABRICATED_ENDORSEMENT`: Endorsement from Satya Nadella.
  - `FABRICATED_PATENT`: 4 US patents.
  - `FABRICATED_AWARD`: Forbes 30 Under 30.

**Benchmark Target**:
- Recall on planted fabrications: **100%** (21/21 caught).
- False block rate on clean cases: $\le \mathbf{5\%}$ (0/21 caught, 0% false blocks).

### 3.2 Recorded-HTTP ATS Fixtures (`tests/fixtures/http-recorded/`)
Provides complete offline deterministic playback for discovery:
- `greenhouse/`: Multi-page job list (page 1 and page 2).
- `lever/`: Postings with categories and apply URLs.
- `ashby/`: Job board with compensation tier summaries.
- `workday/`: Paginated POST responses across offsets 0 and 20.
- `smartrecruiters/`: Paginated postings across pages 1 and 2.
- `rate-limit/`: HTTP 429 response with `Retry-After: 1` header.
- `index.js`: Mock server configuration with dynamic playback routes.

### 3.3 Candidate Dossiers (`tests/fixtures/dossiers/`)
- `morgan-vance.json`: Fictional Principal Platform Architect with 10 verified claims, 3 employers, CKA certification, and Ph.D.
- `alex-rivera.json`: Fictional Staff Full-Stack Engineer with 4 verified claims, 2 employers, and B.Sc.

---

## 4. Execution Commands

```bash
# Run entire 4-tier test suite
node tests/e2e-runner.js

# Run specific tiers
node tests/e2e-runner.js --tier 1,2
node tests/e2e-runner.js --tier 3,4

# Run only Golden Corpus benchmark
node tests/e2e-runner.js --golden-only

# Run clean-room provenance scan
node tests/e2e-runner.js --clean-room

# Run zero-PII audit
node tests/e2e-runner.js --pii

# Run with verbose assertion output
node tests/e2e-runner.js --verbose
```
