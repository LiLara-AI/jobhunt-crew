# JobHunt Crew

JobHunt Crew is a clean-room, autonomous AI agent crew that discovers career opportunities across multi-channel ATS APIs and job boards, crafts claim-verified honest CVs, and coordinates human-in-the-loop applications through a deterministic event ledger.

---

## 1. Core Philosophy

JobHunt Crew is engineered from first principles with a privacy-first, evidence-based approach to career management:

* **Deterministic Guardrails Enforced in Code**: State transitions are controlled by executable guardrails, never left to soft LLM prompts. Only a verified human actor can advance an application to `submitted`. A vacancy cannot be closed without objective evidence (HTTP 404/410 status, an explicit closure notice, or a passed application deadline).
* **Zero Personal PII & Local-First State**: 100% of workspace data, job queues, and application files reside on your local machine. No external SaaS databases, Supabase instances, or third-party cloud stores are ever queried. Personal candidate identifiers live strictly in gitignored files (`.pii-denylist`); all repository fixtures and tests use fictional personas.
* **Honest-CV Pipeline & Claim Verification**: Every metric, credential, title, employer, and achievement cited in tailored CVs or cover letters must map directly to verified claims in the candidate dossier (`CareerDossier.md` / `dossier.json`). An AST/NLP verification engine (`lib/honest-cv/verify-claims.js`) deterministically blocks any hallucinated numbers, ungrounded tools, or transplanted employer facts.
* **`[CONFIRM]` Gate for New Discoveries**: Any novel accomplishment or modified wording introduced during drafting is routed to an explicit candidate approval gate before touching the baseline profile.
* **Candidate-Isolated Blind Review**: The review panel evaluates tailored application drafts with zero access to the candidate profile, ensuring genuine hiring-manager and recruiter critique.
* **Multi-Channel Maximum Discovery**: Reaches beyond public web search by querying direct Applicant Tracking System (ATS) REST APIs (Greenhouse, Lever, Ashby, Workday, SmartRecruiters, Oracle Cloud HCM), enterprise watchlists, and attended Chrome DevTools MCP sessions across regional job boards.
* **Zero Age Penalty**: Open vacancies are never dropped or penalized simply because they were posted more than 30 or 60 days ago. Requisitions remain active until verified closed.
* **Strict Human-in-the-Loop Agency**: Application preparation and attended browser pre-filling stop strictly before final submission. The system never enters user passwords, payment information, or account credentials.

---

## 2. High-Level Architecture

```
                                  +---------------------------------------+
                                  |         User & Human Decisions        |
                                  +---------------------------------------+
                                        |                           |
                                        v                           v
                       +----------------------------------+  +----------------------------+
                       | Local Command Center (127.0.0.1) |  | Gemini Desktop Companion   |
                       | Token Auth · 5 Modern Views      |  | Inbox Proposal Bridge      |
                       +----------------------------------+  +----------------------------+
                                        |                                   |
                                        +-------------------+---------------+
                                                            |
                                                            v
+-------------------------------------------------------------------------------------------------------------------+
|                                        Deterministic Tool Surface & CLI                                           |
|                                       bin/crew.js  ·  Native MCP Server                                           |
+-------------------------------------------------------------------------------------------------------------------+
                                                            |
                +-------------------------------------------+-----------------------------------------+
                |                                           |                                         |
                v                                           v                                         v
+-------------------------------+           +-------------------------------+         +-----------------------------+
|    Append-Only Event Ledger   |           |    Deterministic Guardrails   |         |    Materialized Snapshot    |
| .crew/ledger.jsonl (Immutable)|           | Enforced in Executable Code   |         | .crew/snapshot.json         |
| Monotonic seq · Hash chaining |           | Human-only submit · Dedup     |         | Pure reducer projection     |
| Atomic lockfile (ledger.lock) |           | Evidence closure · Gate check |         | Fast state access           |
+-------------------------------+           +-------------------------------+         +-----------------------------+
                ^
                | State-driven waking
+-------------------------------------------------------------------------------------------------------------------+
|                                              Agent Crew Topology                                                  |
|  Dispatcher (Flash)  ·  Recon (Flash)  ·  Scribe (Pro)  ·  Inquisitor (Pro+Script)  ·  Critic (Pro)                |
|  Liaison (Flash)  ·  Navigator (Flash)                                                                            |
+-------------------------------------------------------------------------------------------------------------------+
                                |                                                           |
                                v                                                           v
+-------------------------------------------------------+   +-------------------------------------------------------+
|            Antigravity Scheduled Tasks                |   |              Claude Code / Cowork Plugin              |
| sidecar.json (CRON_TZ, agentapi new-conversation --)  |   | plugin.json, skills, identical single-source engine   |
+-------------------------------------------------------+   +-------------------------------------------------------+
```

### Core Architecture Components

1. **Deterministic Tool Surface (`bin/crew.js` & MCP Server)**: Agents interact with system state exclusively through a standardized, validated tool API. Direct, manual editing of state files is strictly disallowed.
2. **Append-Only Event Ledger (`.crew/ledger.jsonl`)**: The single immutable source of truth. Every transition (job discovered, triaged, claimed, drafted, verified, reviewed, or submitted) is recorded as a cryptographically hash-chained event with sequential ID and UTC timestamp.
3. **Pure Reducer Projection (`.crew/snapshot.json`)**: A deterministic projection derived by playing back ledger events from event #1. If deleted, it can be recomputed instantaneously.
4. **Cross-Process Concurrency (`.crew/ledger.lock`)**: Atomic lockfile mechanism with process ID verification, lease heartbeats, and stale-lease reclamation, allowing four or more concurrent agents to execute safely without data collisions.
5. **Local Web Command Center (127.0.0.1)**: Token-secured local interface featuring five distinct views:
   - **Decision Queue**: Pending human actions (shortlisting, claim confirmation, package sign-off, outreach approval).
   - **Pipeline Board**: Lifecycle status of every active vacancy from discovery to interview/offer.
   - **Workbench**: Interactive review and diffing for tailored CV and cover letter drafts.
   - **Evidence Map**: Matrix cross-referencing candidate claims against job description requirements.
   - **Runs Timeline**: Verifiable audit log of all automated crew executions.

---

## 3. The Agent Crew

JobHunt Crew organizes responsibilities across seven dedicated agents, assigning each task to its optimal Gemini model tier:

| Agent | Model Tier | Primary Role & Responsibilities | Activation Mechanism |
|---|---|---|---|
| **Dispatcher** | Gemini Flash | Monitors ledger state and queue health; wakes downstream agents only when actionable items exist. | Antigravity Scheduled Task / Cron |
| **Recon** | Gemini Flash | Executes 4-channel discovery (ATS REST APIs, watchlist, attended DevTools MCP, search); normalizes URLs and scores matches against preferences. | Awakened by Dispatcher when sweep is due |
| **Scribe** | Gemini Pro | Drafts claim-grounded tailored CVs and cover letters; formulates multi-vacancy strategy; generates RTL Arabic formatting when required. | Awakened when vacancies are shortlisted |
| **Inquisitor** | Gemini Pro + Script | Executes deterministic AST/NLP claim verification (`verify-claims.js`); enforces the `[CONFIRM]` gate; maps ATS keyword coverage. | Awakened when a draft is completed |
| **Critic** | Gemini Pro | Operates as a candidate-isolated blind review panel (Recruiter + Hiring Manager personas) with candidate profile access strictly barred. | Awakened when claims are verified |
| **Liaison** | Gemini Flash | Parses inbound communication signals (read-only); manages 7/14-day follow-up cadences; crafts outreach drafts (<300 chars); prepares daily briefing. | Scheduled morning execution / Inbox signal |
| **Navigator** | Gemini Flash | Verifies job-board session health; conducts attended browser navigation; pre-fills profile updates (`ready-to-save`). | Scheduled weekly / Manual command |

---

## 4. Setup & Platform Installation

### Prerequisites
* Node.js version 18.0.0 or higher (Node 20+ LTS recommended).
* Google Antigravity 2.0 (primary execution environment) or Claude Code / Claude Cowork.

### Initializing the Workspace
```bash
# Clone the repository
git clone https://github.com/LiLara-AI/jobhunt-crew.git
cd jobhunt-crew

# Initialize the clean-room workspace
node bin/crew.js init
```

### Running on Google Antigravity 2.0
1. **Register the Native MCP Server**:
   Configure the `crew` tool surface in your Antigravity MCP settings:
   ```json
   {
     "mcpServers": {
       "crew": {
         "command": "node",
         "args": ["<path-to-jobhunt-crew>/bin/crew.js", "mcp"]
       }
     }
   }
   ```
2. **Generate Scheduled Task Sidecars**:
   ```bash
   node lib/setup-antigravity-tasks.js --install-sidecars --timezone Asia/Riyadh --hour 8
   ```
3. **Execution**: The `Dispatcher` agent activates on schedule, evaluating the event ledger and waking the crew as work appears.

### Running on Claude Code / Claude Cowork
This repository is a Claude plugin marketplace (`.claude-plugin/marketplace.json`).
Install it directly from GitHub, no clone required:

```
/plugin marketplace add LiLara-AI/jobhunt-crew
/plugin install jobhunt-crew@jobhunt-crew
```

Equivalent terminal commands:

```bash
claude plugin marketplace add LiLara-AI/jobhunt-crew
claude plugin install jobhunt-crew@jobhunt-crew
```

> **MCP tools are registered separately.** Cowork's marketplace validator
> rejects plugin-bundled stdio MCP servers, so the plugin ships skills and
> agents only. To enable the `crew_*` MCP tools in Claude Code, register the
> bundled server once (skills also work through the `crew` CLI without it):
>
> ```bash
> claude mcp add crew -- node /path/to/jobhunt-crew/bin/crew-mcp.js --workspace /path/to/jobhunt-crew
> ```

For local development, you can also build and validate the plugin bundle:

```bash
# Build the Claude plugin bundle
node scripts/build-claude-plugin.js

# Validate the generated plugin manifest
claude plugin validate --strict dist/claude-plugin
```

---

## 5. Gemini Desktop Companion Edition

JobHunt Crew includes a companion edition for the **Gemini Desktop Application** (Windows and macOS), grounded strictly in confirmed Google Workspace features:

* **Derived Snapshot Inspection**: Reads `.crew/snapshot.json` to review shortlisted positions, match scores, and interview pipelines.
* **Native Email Signal Intake**: Integrates with Google Workspace via the `@Gmail` extension to detect interview invitations, status updates, or recruiter notes.
* **Asynchronous Proposal Bridge**: Writes suggested candidate actions or tailored drafts to `<workspace>/inbox/proposals/`.
* **Core Validation Gate**: On its subsequent Antigravity execution, the core data engine inspects companion proposals, passing drafts through the deterministic verifier and strictly preventing any unauthorized state modifications.

### Antigravity-Only Capabilities
To protect data integrity, the following features require system-level execution and are designated as **Antigravity Only** (not executed within the Gemini Desktop Companion):
* Attended Chrome DevTools MCP browser automation and form pre-filling.
* Local HTTP Command Center server (127.0.0.1 token authentication).
* Direct ATS REST API automated sweeps and rate-limited HTTP crawlers.
* Atomic multi-process concurrency locking (`.crew/ledger.lock`).
* Standalone CLI operations (`bin/crew.js`).

---

## 6. Verification & Clean-Room Provenance

JobHunt Crew enforces strict, verifiable clean-room standards:

### Clean-Room Shingle Analysis
Verify that no code or documentation contains unauthorized textual overlap with restricted reference repositories:
```bash
node .clean-room/clean-room-check.js scan .
```
*Expected Result*: Exit code `0` (`PASS`), verifying zero unauthorized shingles against SHA-256 reference hashes.

### Zero-PII Verification
Audit the repository against the local PII denylist to guarantee zero committed personal identifiers:
```bash
node scripts/verify-zero-pii.js
```

### End-to-End Test Suite
Run the comprehensive test suite, including the 42-case Golden Corpus verifier benchmark:
```bash
npm test
```

### System Health Diagnostic
Run the built-in diagnostic utility to check connectors, session health, and ledger integrity:
```bash
node bin/crew.js doctor
```

---

## 7. License & Notices

Distributed under the **MIT License**. Copyright (c) 2026 JobHunt Crew Authors. See [LICENSE](LICENSE) for full details.

For third-party attributions, clean-room provenance declarations, and conceptual acknowledgments, refer to [NOTICE](NOTICE).
