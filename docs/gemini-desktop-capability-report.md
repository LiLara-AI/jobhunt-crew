# Gemini Desktop Companion Capability Report & Platform Assessment

**Document**: `docs/gemini-desktop-capability-report.md`  
**System**: JobHunt Crew  
**Milestone**: M7 (Gemini Desktop Companion Edition — Requirement R9)  
**Author**: JobHunt Crew Engineering  
**Version**: 1.0.0  

---

## 1. Executive Summary

Requirement R9 mandates that JobHunt Crew support interaction from the **Google Gemini desktop application** (installed locally as `com.google.gemini.windows` and available for macOS as `gemini.google/mac`). The system must ground its companion implementation strictly in **Google's official documentation and verified runtime capabilities**, never claiming unsupported functionality or simulating unconfirmed features.

Any capability that cannot be confirmed via official documentation or binary inspection must be designated as **"Antigravity only"** in the documentation.

This report documents:
1. Empirical binary analysis of the installed `com.google.gemini.windows` client.
2. Official Google support documentation catalog with exact URLs and article IDs.
3. The authoritative capability classification matrix (Confirmed vs Antigravity-Only).
4. The asynchronous proposal bridge architecture (`inbox/proposals/`) ensuring deterministic core guardrails and zero state corruption.

---

## 2. Empirical Binary Analysis: `com.google.gemini.windows`

### 2.1 Package & System Registry Inspection
Inspection of the local Windows environment confirms the installed client properties:
- **Registry Key**: `HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\{com.google.gemini.windows}`
- **Display Name**: `Gemini`
- **Display Version**: `1.16.0`
- **Publisher**: `Google LLC`
- **Installation Directory**: `C:\Users\<user>\AppData\Local\Google\Gemini\app-1.16.0`
- **Runtime Host**: Electron v42.4.1 (Chromium / Node.js)
- **Application Archive**: `resources\app.asar`
- **Main Script**: `src/main.js` navigating to `https://gemini.google.com/app`

### 2.2 Security Sandbox & Preload API Surface (`src/preload.js`)
Decompilation and inspection of `src/preload.js` within `app.asar` reveals the complete set of native APIs exposed to the web renderer via `contextBridge.exposeInMainWorld('geminiNative', ...)`:
- `appVersion`: Returns client version string.
- `localDeviceId`: Generates or reads unique machine telemetry ID.
- `log(level, tag, message)`: Forwards diagnostic messages to Crashpad.
- `syncExperimentFlags` / `getCachedFlags` / `pollExperimentFlagsNow`: Synchronizes experiment feature toggles.
- `getWindowSources()` / `captureWindow(windowId)`: Desktop capturer for visual window sharing.
- `notifyTurnLifecycle`: Emits conversation turn timing metrics.

### 2.3 Verified Negative Findings (Capabilities Absent in Desktop App)
1. **Zero Local File System Access**: The Electron wrapper completely omits `fs`, `path`, or native file-picker bindings in the renderer. The desktop application cannot read arbitrary local folders or write directly to local files without browser file upload/download prompts.
2. **Zero Local Process Execution**: Neither `child_process`, `exec`, nor `spawn` is exposed. The app cannot invoke local CLI commands such as `bin/crew.js`.
3. **Zero Local Stdio MCP Transport**: The wrapper does not support spawning local MCP servers over standard input/output.
4. **Zero Headless Browser Automation**: CDP (Chrome DevTools Protocol) interfaces are not available to user prompts; window sharing is limited to image capture via `captureWindow`.

---

## 3. Official Google Documentation Catalog

Every feature evaluated has been verified against official Google documentation:

### 3.1 Windows Desktop App
- **Article Title**: Use the Gemini app for Windows
- **Official URL**: `https://support.google.com/gemini/answer/18263854`
- **Article ID**: `18263854`
- **Key Capabilities**: Global hotkey (`Alt + Space`), quick responses, text drafting, summarizing, brainstorming, coding support, and image uploads.

### 3.2 macOS Desktop App
- **Article Title**: Use the Gemini app on Mac
- **Official URL**: `https://support.google.com/gemini/answer/17011627`
- **Article ID**: `17011627`
- **Key Capabilities**: Global hotkey (`Option + Space`), "Speak to Window" voice dictation (hold `fn`), window sharing context, Apple Silicon macOS Sequoia 15.0+, and experimental "Connected Folders" for designate folder read/edit with automated backups.

### 3.3 Custom Gems
- **Article Title**: Create and use Gems in Gemini Apps
- **Official URL**: `https://support.google.com/gemini/answer/15234293`
- **Article ID**: `15234293`
- **Key Capabilities**: Custom persona and system prompt instructions, uploadable reference knowledge files (markdown, text, PDFs, Sheets). Synchronized across Web, Windows, macOS, and mobile clients.

### 3.4 Uploaded Skills (`SKILL.md` / `/skills`)
- **Article Title**: Create & manage skills for Gemini Apps
- **Official URL**: `https://support.google.com/gemini/answer/17094296`
- **Article ID**: `17094296`
- **Key Capabilities**: Modular YAML-frontmatter skills with instructions and bundled resources. Supported on Web, macOS desktop, and mobile.

### 3.5 Workspace Extensions (`@Gmail`, `@Google Drive`, `@Google Calendar`)
- **Article Title**: Use & manage Connected Apps in Gemini
- **Official URL**: `https://support.google.com/gemini/answer/13695044`
- **Article ID**: `13695044`
- **Key Capabilities**: Connecting Google Workspace apps to search emails (`@Gmail`), summarize recruiter communications, and reference documents in Drive. Read-only context intake.

### 3.6 Scheduled Actions & Recurring Prompts
- **Article Title**: Schedules in Gemini Apps
- **Official URL**: `https://support.google.com/gemini/answer/16316416` (and `https://support.google.com/gemini/answer/17094710`)
- **Article IDs**: `16316416`, `17094710`
- **Key Capabilities**: Conversational creation of recurring prompt schedules (daily morning briefings, weekly reviews) with background preparation.

### 3.7 Model Context Protocol (MCP) in Gemini Apps
- **Article Title**: Connect & manage custom apps for Gemini Apps
- **Official URL**: `https://support.google.com/gemini/answer/17209137`
- **Article ID**: `17209137`
- **Constraints**: Requires personal Google Account (18+, US location) and remote **HTTP/SSE server endpoint**. Does NOT support local stdio subprocess spawning (`node bin/crew.js mcp`).

### 3.8 Task Mode & Browser Interaction
- **Article Title**: Manage your tasks & workflows in Gemini Apps
- **Official URL**: `https://support.google.com/gemini/answer/17094507`
- **Article ID**: `17094507`
- **Constraints**: Multi-step automated task flows using Chrome auto-browse or cloud browser (Web and Mac only, Google AI Pro/Ultra). Strictly consumer-focused with required interactive confirmations; not suited for high-throughput headless ATS sweeps.

---

## 4. Authoritative Capability Classification Matrix

| Capability | Status | Official Citation | Implementation in JobHunt Crew |
|---|---|---|---|
| **Custom Gem System Prompt** | **CONFIRMED** | `answer/15234293` | Ship `gemini-desktop-pack/GEM_SYSTEM_PROMPT.md` and `agents/gemini-desktop-companion.md` for one-click setup. |
| **Workspace `@Gmail` Integration** | **CONFIRMED** | `answer/13695044` | Used for conversational inbound signal monitoring (interview invites, rejections); outputs proposal files. |
| **Workspace `@Google Drive` Context** | **CONFIRMED** | `answer/13695044` | Candidate dossier and snapshot reference through synchronized Drive files. |
| **Scheduled Briefings** | **CONFIRMED** | `answer/16316416` | User configures recurring morning briefing schedule ("Summarize my JobHunt Crew pipeline status"). |
| **Web Search Grounding** | **CONFIRMED** | `answer/13695044` | Ad-hoc employer research, recent news, and live requisition verification. |
| **Uploaded Skills (`SKILL.md`)** | **CONFIRMED (Mac/Web)** | `answer/17094296` | Ship `gemini-desktop-pack/SKILL.md` for macOS and web users who prefer skill packages. |
| **Connected Local Folders** | **CONFIRMED (Mac Only)** / **NOT SUPPORTED (Windows)** | Mac: `answer/17011627`<br>Win: `answer/18263854` | Windows client lacks folder connection; bridge uses standard filesystem workspace directory (`inbox/proposals/`). |
| **Attended DevTools Browser Automation** | **ANTIGRAVITY ONLY** | Decompiled `src/preload.js` | Automated form pre-filling stopping strictly before submit runs in Antigravity (`Navigator` agent). |
| **Local HTTP Command Center (127.0.0.1)** | **ANTIGRAVITY ONLY** | Architecture boundary | Node.js web server with token authentication runs via `crew ui` in Antigravity or local terminal. |
| **Direct ATS REST API Sweeps** | **ANTIGRAVITY ONLY** | Architecture boundary | High-throughput pagination over Greenhouse, Lever, Ashby, Workday APIs runs via `Recon` agent in Antigravity. |
| **Atomic Concurrency Locking** | **ANTIGRAVITY ONLY** | Architecture boundary | Kernel-level file locking (`.crew/ledger.lock`) executes on host OS runtime during core ledger appends. |
| **Standalone CLI Commands (`bin/crew.js`)** | **ANTIGRAVITY ONLY** | Decompiled `src/preload.js` | CLI surface requires Node.js runtime and terminal access. |

---

## 5. Architectural Bridge Design

To maintain strict guardrails while delivering a smooth desktop experience, JobHunt Crew implements the **Asynchronous Proposal Bridge**:

```
+-------------------------------------------------------------+
|                GEMINI DESKTOP COMPANION                     |
|  1. Reads .crew/snapshot.json & CareerDossier.md            |
|  2. User reviews recommendations, drafts, or @Gmail signals |
|  3. Writes JSON proposals to inbox/proposals/*.json         |
+-------------------------------------------------------------+
                              |
                              | Asynchronous Proposals
                              v
+-------------------------------------------------------------+
|               CORE VALIDATION & INGESTION GATE              |
|                   lib/companion/bridge.js                   |
|                                                             |
|  [Rule 1] Blocks any proposal claiming "submitted"         |
|  [Rule 2] Quarantines draft proposals (unverified: true)    |
|  [Rule 3] Coerces proposed claims to status: "CONFIRM"      |
|  [Safety] Malformed JSON -> quarantined to inbox/errors/    |
|           Guarantees stateCorrupted: false                  |
+-------------------------------------------------------------+
                              |
                              | Validated Events
                              v
+-------------------------------------------------------------+
|              APPEND-ONLY EVENT LEDGER & REDUCER             |
|                    .crew/ledger.jsonl                       |
|                   .crew/snapshot.json                       |
+-------------------------------------------------------------+
```

### Invariant Guarantees
1. **Rule 1 — Zero Unauthorized Submissions**: External proposals cannot authorize job applications. Any file claiming `action: 'submitted'` or `status: 'submitted'` is immediately rejected without modifying state.
2. **Rule 2 — Draft Quarantine**: Any CV, cover letter, or outreach text drafted by the companion is quarantined with status `pending_inquisitor_verification` and action `HOLD_FOR_CLAIM_VERIFICATION`. It can never be marked `ready` until the deterministic AST claim verifier passes with zero violations.
3. **Rule 3 — Gated Claims**: Any candidate claim proposed in the companion is forced to `status: 'CONFIRM'`, requiring candidate review in the Command Center before it can be cited in official documents.
4. **State Corruption Immunity**: Syntactically invalid or rule-violating proposals are moved to `inbox/errors/` with diagnostic `.error.json` sidecars; the primary event ledger and snapshot remain completely untouched (`stateCorrupted: false`).
