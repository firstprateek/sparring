# Probe: claude-agent-acp 0.101.0

Run 2026-11-11T12:52:04Z with `bun tools/acp-probe.ts --version 0.101.0 --phase a`.
Adapter `@agentclientprotocol/claude-agent-acp@0.101.0` from `~/.sparring/adapters/claude`. Bun 1.4.2, node on PATH v26.0.0. Token in config.json: yes.
The MCP proxy was spawned as `/opt/homebrew/Cellar/bun/1.4.2/bin/bun packages/mcp/src/server.ts`.

| Row | Question | Result | Evidence |
|---|---|---|---|
| A1 | Does login work under the isolated config dir? | pass | session/new ok with CLAUDE_CONFIG_DIR=~/.sparring/claude and the token; sessionId "a32fb529-32b9-4529-9a3a-58d280e50288"; the adapter's CLI says auth status {"loggedIn":true,"authMethod":"oauth_token","apiProvider":"firstParty"}; _auth/status_update [{"kind":"none","label":"Not logged in"}] (a setup-token reads as "none" there because it carries no subscription type, so the daemon must not treat it as signed out) |
| A2 | Which mode does the session start in? | pass | modes.currentModeId "default"; availableModes ["default","acceptEdits","plan"] |
| A3 | Is the MCP proxy started? | pass | hello on /var/folders/xz/bc8d_2zn001g4qjp7k1v24xm0000gn/T/sparring-probe-gK9evw/daemon.sock with the right secret (1 hello(s)) |
| A4 | What does the agent advertise? | pass | protocolVersion 1; agentInfo {"name":"@agentclientprotocol/claude-agent-acp","title":"Claude Agent","version":"0.101.0"}; agentCapabilities {"_meta":{"claudeCode":{"promptQueueing":true},"authStatus":{}},"promptCapabilities":{"image":true,"embeddedContext":true},"mcpCapabilities":{"http":true,"sse":true},"auth":{"logout":{}},"providers":{},"loadSession":true,"sessionCapabilities":{"additionalDirectories":{},"close":{},"delete":{},"fork":{},"list":{},"resume":{},"systemPrompt":{"mode":{"override":{}}}}}; sessionCapabilities.systemPrompt {"mode":{"override":{}}}; agentCapabilities.loadSession true; authMethods []; configOptions [{"id":"mode","name":"Mode","description":"Session permission mode","category":"mode","type":"select","currentValue":"default","options":[{"value":"default","name":"Manual","description":"Always ask before making changes"},{"value":"acceptEdits","name":"Accept edits","description":"Automatically accept all file edits"},{"value":"plan","name":"Plan","description":"Create a plan before making changes"}]},{"id":"model","name":"Model","description":"AI model to use","category":"model","type":"select","currentValue":"default","options":[{"value":"default","name":"Default (recommended)","description":"Sonnet"},{"value":"sonnet","name":"Sonnet 5.5","description":"Sonnet 5.5 · Efficient for routine tasks"},{"value":"fable","name":"Fable 5.1","description":"Fable 5.1 · Most capable for your hardest and longest-running tasks"},{"value":"opus","name":"Opus 5.5","description":"Opus 5.5 · Best for everyday, complex tasks"},{"value":"haiku","name":"Haiku 5.5","description":"Haiku 5.5 · Fastest for quick answers"}]},{"id":"effort","name":"Effort","description":"Available effort levels for this model","category":"thought_level","type":"select","currentValue":"default","options":[{"value":"default","name":"Default"},{"value":"low","name":"Low"},{"value":"medium","name":"Medium"},{"value":"high","name":"High"},{"value":"xhigh","name":"Xhigh"},{"value":"max","name":"Max"}]},{"id":"ultracode","name":"Ultracode","description":"Dynamic workflows on every task, at any effort level","category":"model_config","type":"select","currentValue":"off","options":[{"value":"on","name":"On"},{"value":"off","name":"Off"}]}] |
| B1 | Does a tool call reach the socket? | not run | phase B not requested (it spends tokens) |
| B2 | What does a permission request for an MCP tool carry? | not run | phase B not requested (it spends tokens) |
| B3 | Is the tool list only the Sparring tools? | not run | phase B not requested (it spends tokens) |
| M2 | Can a launchd job reach the site remote? | not run | out of scope for this probe |
| M3 | Does the site keep raw HTML? | not run | out of scope for this probe |

Session updates seen: available_commands_update.
Other notifications seen: none.
Agent exit code: still running at the end (closed by the probe).
