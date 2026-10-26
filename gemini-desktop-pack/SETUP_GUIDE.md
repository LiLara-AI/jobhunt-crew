# JobHunt Crew Companion — Setup & Onboarding Guide

**Version**: 1.0.0  
**Compatibility**: Windows (`com.google.gemini.windows`), macOS (`gemini.google/mac`), and Web (`gemini.google.com`)  
**Official Reference**: [Google Support: Create and use Gems in Gemini Apps](https://support.google.com/gemini/answer/15234293)  

---

## 1. Overview

The **JobHunt Crew Companion** allows you to interact with your local job search engine directly from the Google Gemini Desktop application or Web interface. Using only confirmed Google capabilities:
- You can query your pipeline status and get daily morning briefings.
- You can review and triage newly discovered roles.
- You can draft tailored CVs and cover letters referencing verified career claims.
- You can practice mock interviews and review offer benchmarks.

All decisions and drafts are exchanged safely through the **Asynchronous Proposal Bridge** (`inbox/proposals/`), ensuring that core deterministic guardrails are never bypassed and state is never corrupted.

---

## 2. Prerequisites

1. **JobHunt Crew Initialized**: Ensure your workspace has run `crew init` and has an active `.crew/` directory.
2. **Gemini Access**: A Google account with Gemini access (Gemini Advanced/Pro for Custom Gems).
3. **Workspace Folders**: Ensure the following directory exists:
   ```
   <workspace>/
   └── inbox/
       ├── proposals/   # Pending proposals written by Gemini
       ├── processed/   # Successfully ingested proposals
       └── errors/      # Quarantined rule violations or malformed files
   ```
   *(If missing, run `node bin/crew.js init` or `node bin/crew.js companion status` to initialize them).*

---

## 3. Setup Instructions: Custom Gem

### Step 1: Open Gems Manager
1. In your browser or desktop app, navigate to [gemini.google.com](https://gemini.google.com).
2. On the left navigation sidebar, click on **Gems** (or **Gems Manager**).
3. Click the **"New Gem"** or **"+"** button to create a Gem.

### Step 2: Configure Gem Identity
- **Name**: `JobHunt Crew Companion`
- **Description**: `Executive career co-pilot that triages roles, drafts honest materials, and coordinates job search workflows.`

### Step 3: Set System Instructions
1. Open `gemini-desktop-pack/GEM_SYSTEM_PROMPT.md` (or `agents/gemini-desktop-companion.md`).
2. Copy the entire system prompt text.
3. Paste it into the **"Instructions"** field of your new Gem.

### Step 4: Attach Knowledge Files (Context)
To give your Gem instant awareness of your career and active pipeline:
1. Under **"Knowledge"**, click **Attach Files** (or upload).
2. Select:
   - `<workspace>/.crew/snapshot.json` (current pipeline state)
   - `<workspace>/dossier.json` or `<workspace>/CareerDossier.md` (verified career claims)
3. *(Optional)* On macOS with experimental Connected Folders enabled, connect the entire `jobhunt-crew` directory.

### Step 5: Save & Test
1. Click **"Save"** or **"Create"**.
2. Your Gem is now live and synchronized across Gemini Web, Windows Desktop, macOS, and mobile apps.

---

## 4. Platform-Specific Setup Notes

### Windows (`com.google.gemini.windows`)
- The Windows client operates as a secure Electron wrapper.
- To communicate with JobHunt Crew, when Gemini drafts proposals or records decisions in chat, save the JSON payload to `<workspace>/inbox/proposals/<filename>.json`.
- In Antigravity or terminal, run:
  ```bash
  node bin/crew.js companion ingest
  ```
  to ingest all pending proposals into the event ledger.
- For continuous background ingestion while working, run:
  ```bash
  node bin/crew.js companion ingest --watch
  ```

### macOS (`gemini.google/mac`)
- On macOS Sequoia (15.0+) with Apple Silicon, the desktop app supports experimental "Connected Folders".
- Designate `<workspace>` as a connected folder.
- You can use the global hotkey `Option + Space` or "Speak to Window" (hold `fn`) to review opportunities and dictate revisions directly into your active editor.

---

## 5. Daily Usage Routine

1. **Morning Briefing**:
   - Open Gemini Desktop.
   - Say: *"Give me my morning briefing based on my snapshot."*
   - Review new job matches and pending follow-ups.
2. **Reviewing Opportunities**:
   - Discuss an opening: *"Should I apply to Stripe Staff Architect? Compare against my dossier."*
   - Tell Gemini: *"Shortlist this role."* -> Gemini writes `inbox/proposals/triage_stripe.json`.
3. **Core Ingestion**:
   - Run `node bin/crew.js companion ingest` (or let the scheduled Dispatcher agent ingest it).
   - Ingestion updates `.crew/ledger.jsonl` and `.crew/snapshot.json`.
4. **Drafting & Honest-CV Gate**:
   - Ask Gemini: *"Draft a cover letter for the Stripe role using claims [C-01] and [C-04]."*
   - The draft is saved to `inbox/proposals/` and quarantined as `HOLD_FOR_CLAIM_VERIFICATION`.
   - The deterministic AST claim verifier verifies all claims before final generation.
