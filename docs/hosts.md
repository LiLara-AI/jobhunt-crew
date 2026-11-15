# Running JobHunt Crew on each host

Everything runs on plain Node.js 18+ (`node --version`). Two paths appear below:

- `<plugin>`: where JobHunt Crew lives (this repo clone, or the installed plugin folder).
- `<workspace>`: your job-hunt folder holding `.crew/`, `dossier.json`, and `applications/`.
  Create it once with `node <plugin>/bin/crew.js init --workspace <workspace>`.

Use absolute paths. On Windows, use forward slashes or escaped backslashes in JSON/TOML.

| Host | Skills | `crew_*` tools |
| --- | --- | --- |
| Claude Code (CLI, Desktop Code tab) | plugin | MCP (optional) or CLI bridge |
| Claude Cowork | plugin | CLI bridge (built in, nothing to set up) |
| Claude Desktop chat | — | MCP via `claude_desktop_config.json` |
| Codex (ChatGPT plan, CLI/IDE/app) | `AGENTS.md` | MCP via `~/.codex/config.toml` |
| ChatGPT (web/desktop chat) | — | MCP over HTTPS (developer mode connector) |
| Kimi Code CLI | `--skills-dir` | CLI bridge (no setup) |
| Gemini CLI | extension | MCP via `gemini-extension.json` |

The **CLI bridge** runs any tool without MCP, with the same code path:

```bash
node <plugin>/bin/crew.js tool list
node <plugin>/bin/crew.js tool crew_doctor --workspace <workspace>
node <plugin>/bin/crew.js tool crew_get_job --workspace <workspace> --args '{"job_id":"job_123"}'
```

Any agent that can run shell commands (Cowork, Codex, Kimi CLI) can drive the
whole crew this way, even with no MCP server registered.

---

## Claude Code and Claude Cowork

Install the plugin from the marketplace:

```bash
claude plugin marketplace add LiLara-AI/jobhunt-crew
claude plugin install jobhunt-crew@lilara-jobhunt
```

In Cowork, add the same marketplace in **Customize → Plugins**, then connect your
job-hunt folder to the task. The skills call the bundled CLI bridge at
`${CLAUDE_PLUGIN_ROOT}/bin/crew.js` and pass your connected folder as the
workspace, so no MCP setup is needed. The plugin deliberately declares no MCP
server: Cowork's marketplace sync rejects bundled stdio servers.

Optional, Claude Code only: register the MCP server for native tool calls.

```bash
claude mcp add crew -e CREW_WORKSPACE=<workspace> -- node <plugin>/bin/crew-mcp.js
```

## Claude Desktop chat

Add to `claude_desktop_config.json` (Settings → Developer → Edit Config), then restart Claude:

```json
{
  "mcpServers": {
    "crew": {
      "command": "node",
      "args": ["<plugin>/bin/crew-mcp.js", "--workspace", "<workspace>"]
    }
  }
}
```

## Codex (ChatGPT plan)

`~/.codex/config.toml`:

```toml
[mcp_servers.crew]
command = "node"
args = ["<plugin>/bin/crew-mcp.js", "--workspace", "<workspace>"]
```

Copy `<plugin>/rules/AGENTS.md` into `<workspace>/AGENTS.md` so Codex loads the
operating rules, and run Codex from `<workspace>`. The playbooks in
`<plugin>/skills/*/SKILL.md` work as prompts ("follow `<plugin>/skills/honest-cv/SKILL.md`").

## ChatGPT (web and desktop chat)

ChatGPT only connects to remote MCP servers over HTTPS, so run the server in
HTTP mode and publish it through a tunnel.

1. Start the server (it prints a URL with a random secret token):

   ```bash
   node <plugin>/bin/crew-mcp.js --http --port 8787 --workspace <workspace>
   ```

   Pass `--token <secret>` (or set `CREW_MCP_TOKEN`) to keep the same URL across restarts.

2. Expose it with any HTTPS tunnel, for example:

   ```bash
   cloudflared tunnel --url http://127.0.0.1:8787
   ```

3. In ChatGPT, turn on developer mode (Settings → Apps & Connectors → Advanced),
   create a connector, use `https://<tunnel-host>/mcp/<token>` as the URL, and
   choose no authentication. The token in the path is the access control:
   anyone with the full URL can read and write your job-hunt data, so do not
   share it, and stop the tunnel when you are done.

Plan limits and menu names change often; check OpenAI's current help pages if
the options above are missing. Some plans only allow read-only connectors.

## Kimi Code CLI

Kimi Code loads the skills directly, and they drive the engine through the CLI
bridge, so no MCP setup is needed. From `<workspace>`:

```bash
kimi --skills-dir <plugin>/skills
```

Then ask, for example, "use the jobhunt-crew setup skill". Optionally copy
`<plugin>/rules/AGENTS.md` to `<workspace>/AGENTS.md` so the operating rules
load in every session. (Verified with Kimi Code 2.5.1, which has no
`--mcp-config-file` flag.)

Kimi's web chat (kimi.com) cannot launch local tools. Use Kimi Code CLI, or
paste a skill's instructions and work with the files by hand.

## Gemini CLI

```bash
gemini extensions install <plugin>
```

`gemini-extension.json` registers the MCP server and loads `rules/AGENTS.md`.
Set `CREW_WORKSPACE` or start Gemini from your workspace folder.
