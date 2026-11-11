// Step 0 of the build (design section 9): probe the pinned Claude ACP adapter.
//
//   bun tools/acp-probe.ts [--install] [--version 0.101.0] [--phase a|b]
//
// --install  installs @agentclientprotocol/claude-agent-acp@<version> exactly, with a lockfile, into
//            ~/.sparring/adapters/claude/. Without it the probe uses what is already there.
// --phase a  (default) sends no prompt and spends no tokens: rows A1 to A4.
// --phase b  also sends three scripted prompts (rows B1 to B3). This spends the owner's tokens.
//
// The probe plays the daemon: it listens on a scratch Unix socket, answers every MCP tool call with a
// fixed result, spawns the adapter with the design's env allow-list and handshake, and answers every
// permission request with the design's policy. It writes docs/probe-claude-<version>.md. Every
// JSON-RPC line (with the token scrubbed) goes to transcript.jsonl in the scratch folder it prints.
import { type ChildProcessWithoutNullStreams, execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Socket } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

type Json = Record<string, unknown>;
interface RpcReply {
  result?: Json;
  error?: { code?: number; message?: string; data?: unknown };
}

// ---------------------------------------------------------------------------------------------- args

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 ? argv[at + 1] : undefined;
};
const VERSION = flag("version") ?? "0.101.0";
const PHASE = flag("phase") ?? "a";
const INSTALL = argv.includes("--install");
if (!["a", "b"].includes(PHASE) || !/^\d+\.\d+\.\d+$/.test(VERSION)) {
  console.error("usage: bun tools/acp-probe.ts [--install] [--version 0.101.0] [--phase a|b]");
  process.exit(2);
}

// --------------------------------------------------------------------------------------------- paths

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HOME = homedir();
const SPARRING = join(HOME, ".sparring");
const ADAPTER_DIR = join(SPARRING, "adapters", "claude");
const PACKAGE = "@agentclientprotocol/claude-agent-acp";
const ADAPTER_BIN = join(ADAPTER_DIR, "node_modules", ".bin", "claude-agent-acp");
const CLAUDE_DIR = join(SPARRING, "claude");
const CONFIG = join(SPARRING, "config.json");
const MCP_SERVER = join(REPO, "packages", "mcp", "src", "server.ts");
const REPORT = join(REPO, "docs", `probe-claude-${VERSION}.md`);

const SETTINGS = {
  permissions: {
    defaultMode: "default",
    disableAutoMode: "disable",
    disableBypassPermissionsMode: "disable",
    allow: ["mcp__sparring"],
    deny: ["Bash", "Write", "Edit", "NotebookEdit", "WebFetch", "WebSearch", "Agent", "Task"],
    blockReadsOutsideWorkingDirectories: true,
  },
};
const DISALLOWED = ["Bash", "Write", "Edit", "NotebookEdit", "WebFetch", "WebSearch", "Agent", "Task"];

const started = Date.now();
const say = (line: string) =>
  console.log(`${((Date.now() - started) / 1000).toFixed(1).padStart(6)}s  ${line}`);

function privateDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

// ------------------------------------------------------------------------------------ install, setup

function install(): void {
  privateDir(SPARRING);
  privateDir(join(SPARRING, "adapters"));
  privateDir(ADAPTER_DIR);
  const manifest = join(ADAPTER_DIR, "package.json");
  if (!existsSync(manifest)) {
    writeFileSync(
      manifest,
      `${JSON.stringify({ name: "sparring-adapter-claude", private: true, description: "installed by tools/acp-probe.ts" }, null, 2)}\n`,
    );
  }
  say(`installing ${PACKAGE}@${VERSION} into ${ADAPTER_DIR}`);
  execFileSync(
    "npm",
    ["install", "--save-exact", "--package-lock=true", "--no-fund", "--no-audit", `${PACKAGE}@${VERSION}`],
    { cwd: ADAPTER_DIR, stdio: "inherit" },
  );
}

function installedVersion(): string | undefined {
  const manifest = join(ADAPTER_DIR, "node_modules", ...PACKAGE.split("/"), "package.json");
  if (!existsSync(manifest)) return undefined;
  return String((JSON.parse(readFileSync(manifest, "utf8")) as Json).version);
}

function ensureSettings(): void {
  privateDir(SPARRING);
  privateDir(CLAUDE_DIR);
  const path = join(CLAUDE_DIR, "settings.json");
  if (existsSync(path)) {
    say(`settings    ${path} exists; left as it is`);
    return;
  }
  writeFileSync(path, `${JSON.stringify(SETTINGS, null, 2)}\n`, { mode: 0o600 });
  say(`settings    wrote ${path}`);
}

function readToken(): string | undefined {
  if (!existsSync(CONFIG)) return undefined;
  try {
    const value = (JSON.parse(readFileSync(CONFIG, "utf8")) as Json).claude_oauth_token;
    return typeof value === "string" && value ? value : undefined;
  } catch {
    return undefined;
  }
}

if (INSTALL) install();
const installed = installedVersion();
if (installed !== VERSION || !existsSync(ADAPTER_BIN)) {
  console.error(
    `${PACKAGE}@${VERSION} is not installed in ${ADAPTER_DIR} (found ${installed ?? "nothing"}); run with --install`,
  );
  process.exit(1);
}
ensureSettings();
const TOKEN = readToken();
const scrub = (text: string): string => (TOKEN ? text.split(TOKEN).join("<token>") : text);

// ------------------------------------------------------------------------------- scratch and socket

const SCRATCH = mkdtempSync(join(tmpdir(), "sparring-probe-"));
const SOCK = join(SCRATCH, "daemon.sock");
const ARTICLE = join(SCRATCH, "article");
const TRANSCRIPT = join(SCRATCH, "transcript.jsonl");
mkdirSync(ARTICLE);
const ARTICLE_TEXT = "# Probe\n\nThe probe sentence.\n";
writeFileSync(join(ARTICLE, "article.md"), ARTICLE_TEXT);
writeFileSync(join(ARTICLE, "dump.md"), "A dump for the probe.\n");
writeFileSync(join(ARTICLE, "brief.md"), "# Brief\n");
writeFileSync(join(ARTICLE, "STYLE.md"), "# Style\n");
const log = (direction: string, line: string) => appendFileSync(TRANSCRIPT, `${direction} ${scrub(line)}\n`);
say(`scratch     ${SCRATCH}`);

const SECRET = randomBytes(32).toString("hex");
const socketSeen = {
  hellos: [] as { secretOk: boolean }[],
  calls: [] as { tool: string; args: unknown; secretOk: boolean }[],
  badLines: 0,
};

const daemon = createServer((socket: Socket) => {
  createInterface({ input: socket }).on("line", (line) => {
    log("sock<", line);
    let message: Json;
    try {
      message = JSON.parse(line) as Json;
    } catch {
      socketSeen.badLines++;
      socket.end(`${JSON.stringify({ ok: false, error: "not JSON" })}\n`);
      return;
    }
    const secretOk = message.secret === SECRET;
    let reply: Json;
    if (message.hello === true) {
      socketSeen.hellos.push({ secretOk });
      say(`socket      hello from the MCP proxy, secret ${secretOk ? "matches" : "WRONG"}`);
      reply = { ok: true, text: "" };
    } else {
      const tool = String(message.tool);
      socketSeen.calls.push({ tool, args: message.args, secretOk });
      say(`socket      call ${tool}, secret ${secretOk ? "matches" : "WRONG"}`);
      reply = secretOk
        ? { ok: true, text: `probe: fixed result for ${tool}` }
        : { ok: false, error: "unknown session" };
    }
    log("sock>", JSON.stringify(reply));
    socket.end(`${JSON.stringify(reply)}\n`);
  });
  socket.on("error", () => {});
});
await new Promise<void>((done) => daemon.listen(SOCK, done));
chmodSync(SOCK, 0o600);

// ------------------------------------------------------------------------------------- the adapter

const env: Record<string, string> = {
  CLAUDE_CONFIG_DIR: CLAUDE_DIR,
  CLAUDE_AGENT_ACP_PROTOCOL: "v1",
};
for (const key of ["PATH", "HOME", "LANG", "TMPDIR"]) {
  const value = process.env[key];
  if (value !== undefined) env[key] = value;
}
if (TOKEN) env.CLAUDE_CODE_OAUTH_TOKEN = TOKEN;
say(`spawn       ${ADAPTER_BIN} (env: ${Object.keys(env).sort().join(", ")})`);

const child: ChildProcessWithoutNullStreams = spawn(ADAPTER_BIN, [], {
  cwd: ARTICLE,
  env,
  stdio: ["pipe", "pipe", "pipe"],
});
const stderrLines: string[] = [];
let exitCode: number | null | undefined;
const pending = new Map<number, (reply: RpcReply) => void>();
let nextId = 1;

child.stdin.on("error", () => {});
child.on("exit", (code, signal) => {
  exitCode = code;
  say(`agent exited (${code ?? signal})`);
  for (const settle of pending.values())
    settle({ error: { code: -32099, message: `agent exited (${code})` } });
  pending.clear();
});
createInterface({ input: child.stderr }).on("line", (line) => {
  log("err", line);
  stderrLines.push(scrub(line));
});

function write(message: Json): void {
  const line = JSON.stringify({ jsonrpc: "2.0", ...message });
  log(">", line);
  if (exitCode === undefined) child.stdin.write(`${line}\n`);
}

function request(method: string, params: Json, timeoutMs = 120_000): Promise<RpcReply> {
  if (exitCode !== undefined)
    return Promise.resolve({ error: { code: -32099, message: "agent has exited" } });
  const id = nextId++;
  const reply = new Promise<RpcReply>((settle) => {
    pending.set(id, settle);
    setTimeout(() => {
      if (pending.delete(id)) settle({ error: { code: -32098, message: `${method} timed out` } });
    }, timeoutMs).unref();
  });
  write({ id, method, params });
  return reply;
}

// What the session showed, for the rows.
const seen = {
  toolCalls: [] as { id: string; title: string; toolName: string; kind: string; turn: string }[],
  permissions: [] as {
    turn: string;
    title: string;
    serverName: unknown;
    toolName: string;
    optionKinds: string[];
    answer: string;
    sparring: boolean;
    rawToolCall: unknown;
  }[],
  modeUpdates: [] as string[],
  configUpdates: [] as unknown[],
  updateKinds: new Set<string>(),
  authStatus: [] as unknown[],
  otherNotices: [] as string[],
  reply: "",
};
let turn = "handshake";

function toolNameOf(toolCall: Json): string {
  const meta = ((toolCall._meta ?? {}) as Json).claudeCode as Json | undefined;
  return String(meta?.toolName ?? "");
}

function isSparringCall(toolCall: Json): boolean {
  const meta = ((toolCall._meta ?? {}) as Json).claudeCode as Json | undefined;
  const server = (meta?.mcpServer ?? {}) as Json;
  if (server.name === "sparring") return true;
  return [toolNameOf(toolCall), String(toolCall.title ?? "")].some((name) =>
    name.startsWith("mcp__sparring__"),
  );
}

/** The design's policy.ts: allow_once for Sparring calls, else the first reject, never allow_always. */
function policy(params: Json): Json {
  const toolCall = (params.toolCall ?? {}) as Json;
  const options = (params.options ?? []) as Json[];
  const sparring = isSparringCall(toolCall);
  const pick = sparring
    ? options.find((option) => option.kind === "allow_once")
    : (options.find((option) => option.kind === "reject_once") ??
      options.find((option) => option.kind === "reject_always"));
  const outcome = pick ? { outcome: "selected", optionId: pick.optionId } : { outcome: "cancelled" };
  const meta = ((toolCall._meta ?? {}) as Json).claudeCode as Json | undefined;
  seen.permissions.push({
    turn,
    title: String(toolCall.title ?? ""),
    serverName: (meta?.mcpServer as Json | undefined)?.name,
    toolName: toolNameOf(toolCall),
    optionKinds: options.map((option) => String(option.kind)),
    answer: pick ? String(pick.kind) : "cancelled",
    sparring,
    rawToolCall: toolCall,
  });
  say(`permission  ${String(toolCall.title ?? "?")}: ${pick ? String(pick.kind) : "cancelled"}`);
  return { outcome };
}

function onUpdate(params: Json): void {
  const update = (params.update ?? {}) as Json;
  const kind = String(update.sessionUpdate);
  seen.updateKinds.add(kind);
  if (kind === "agent_message_chunk") {
    const content = update.content as Json | undefined;
    if (content?.type === "text") seen.reply += String(content.text);
  } else if (kind === "tool_call") {
    const entry = {
      id: String(update.toolCallId),
      title: String(update.title ?? ""),
      toolName: toolNameOf(update),
      kind: String(update.kind ?? ""),
      turn,
    };
    seen.toolCalls.push(entry);
    say(`tool call   ${entry.toolName || entry.title} [${entry.kind}]`);
  } else if (kind === "current_mode_update") {
    seen.modeUpdates.push(String(update.currentModeId));
    say(`mode update ${String(update.currentModeId)}`);
  } else if (kind === "config_option_update") {
    seen.configUpdates.push(update);
  }
}

createInterface({ input: child.stdout }).on("line", (line) => {
  log("<", line);
  let message: Json;
  try {
    message = JSON.parse(line) as Json;
  } catch {
    return;
  }
  const id = message.id as number | undefined;
  if (id !== undefined && !("method" in message)) {
    const settle = pending.get(id);
    pending.delete(id);
    settle?.(message as RpcReply);
    return;
  }
  const method = String(message.method ?? "");
  const params = (message.params ?? {}) as Json;
  if (id === undefined) {
    if (method === "session/update") onUpdate(params);
    else if (method === "_auth/status_update") {
      seen.authStatus.push(params.authStatus);
      say(`auth status ${show(params.authStatus)}`);
    } else seen.otherNotices.push(method);
    return;
  }
  if (method === "session/request_permission") {
    write({ id, result: policy(params) });
  } else {
    say(`refused     ${method}`);
    write({ id, error: { code: -32601, message: `not offered: ${method}` } });
  }
});

// ----------------------------------------------------------------------------------------- the rows

interface Row {
  id: string;
  question: string;
  result: "pass" | "fail" | "partial" | "not run";
  evidence: string;
}
const rows: Row[] = [];
const show = (value: unknown): string => scrub(JSON.stringify(value) ?? "undefined");
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

async function waitFor(check: () => boolean, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (check()) return true;
    await sleep(200);
  }
  return check();
}

const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

async function run(): Promise<void> {
  const init = await request("initialize", {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    clientInfo: { name: "sparring", version: "0.0.0-probe" },
  });
  if (!init.result) {
    rows.push({
      id: "A4",
      question: "What does the agent advertise?",
      result: "fail",
      evidence: `initialize failed: ${show(init.error)}; stderr: ${show(stderrLines.slice(-5))}`,
    });
    return;
  }
  const info = init.result;
  const caps = (info.agentCapabilities ?? {}) as Json;
  const sessionCaps = (caps.sessionCapabilities ?? info.sessionCapabilities) as Json | undefined;
  const systemPromptCap = sessionCaps?.systemPrompt;
  say(`initialize  protocol ${show(info.protocolVersion)}, agent ${show(info.agentInfo)}`);

  const mcpServers = [
    {
      name: "sparring",
      command: process.execPath,
      args: [MCP_SERVER],
      env: [
        { name: "SPARRING_MCP_SOCK", value: SOCK },
        { name: "SPARRING_MCP_SECRET", value: SECRET },
      ],
    },
  ];
  const probeRules =
    "You are the Sparring probe. Use only the sparring tools. Never edit files. Answer in one sentence.";
  const sessionParams: Json = {
    cwd: ARTICLE,
    mcpServers,
    _meta: {
      disableBuiltInTools: true,
      claudeCode: {
        options: {
          tools: [],
          allowDangerouslySkipPermissions: false,
          disallowedTools: DISALLOWED,
          settingSources: ["user"],
          strictMcpConfig: true,
        },
      },
    },
  };
  if (systemPromptCap)
    sessionParams.systemPrompt = { mode: "append", content: [{ type: "text", text: probeRules }] };

  const created = await request("session/new", sessionParams);
  const session = created.result;
  say(`session/new ${session ? `ok ${String(session.sessionId)}` : `error ${show(created.error)}`}`);

  // A1. On 0.101.0 a missing credential does not fail session/new: the session is created, the
  // agent sends `_auth/status_update {kind: "none"}`, and the first session/prompt fails with
  // -32000 "Authentication required" (RequestError.authRequired in @agentclientprotocol/sdk).
  await waitFor(() => seen.authStatus.length > 0, 3_000);
  const authEvidence = `_auth/status_update ${show(seen.authStatus)}`;
  if (session) {
    // A setup-token carries no subscription type, so on 0.101.0 the adapter maps a logged-in CLI to
    // `kind: "none"` (auth-status.js mapAuthFields). Its own CLI's `auth status` is the real answer.
    const cli = TOKEN ? cliAuthStatus() : undefined;
    rows.push({
      id: "A1",
      question: "Does login work under the isolated config dir?",
      result: TOKEN ? (cli?.loggedIn === true ? "pass" : "fail") : "partial",
      evidence: TOKEN
        ? `session/new ok with CLAUDE_CONFIG_DIR=${CLAUDE_DIR} and the token; sessionId ${show(session.sessionId)}; ` +
          `the adapter's CLI says auth status ${show(cli)}; ${authEvidence} (a setup-token reads as "none" ` +
          "there because it carries no subscription type, so the daemon must not treat it as signed out)"
        : `no token: session/new did NOT fail, it returned sessionId ${show(session.sessionId)}; ${authEvidence}. ` +
          "The design's -32000 on session/new does not happen; by the adapter source the -32000 " +
          '"Authentication required" comes on the first session/prompt (not sent in phase A). ' +
          "With-token half not run: no claude_oauth_token in config.json",
    });
  } else {
    const code = created.error?.code;
    rows.push({
      id: "A1",
      question: "Does login work under the isolated config dir?",
      result: !TOKEN && code === -32000 ? "partial" : "fail",
      evidence:
        `${TOKEN ? "with" : "without"} the token, session/new error ${show(created.error)}; ${authEvidence}` +
        `; last stderr: ${show(stderrLines.slice(-3))}`,
    });
  }

  // A2
  const modes = (session?.modes ?? undefined) as Json | undefined;
  let modeId = modes ? String(modes.currentModeId) : undefined;
  let setModeEvidence = "";
  if (session && modeId !== "default") {
    const set = await request("session/set_mode", { sessionId: session.sessionId, modeId: "default" });
    setModeEvidence = `; set_mode default -> ${show(set.result ?? set.error)}`;
    if (!set.error) modeId = seen.modeUpdates.at(-1) ?? modeId;
  }
  rows.push({
    id: "A2",
    question: "Which mode does the session start in?",
    result: !session ? "not run" : String(modes?.currentModeId) === "default" ? "pass" : "fail",
    evidence: session
      ? `modes.currentModeId ${show(modes?.currentModeId)}; availableModes ${show(
          ((modes?.availableModes ?? []) as Json[]).map((mode) => mode.id),
        )}${setModeEvidence}`
      : "session/new failed, so there is no session to read a mode from",
  });

  // A3: the proxy says hello on start, if the adapter starts it.
  await waitFor(() => socketSeen.hellos.length > 0, session ? 20_000 : 8_000);
  const hello = socketSeen.hellos[0];
  rows.push({
    id: "A3",
    question: "Is the MCP proxy started?",
    result: hello?.secretOk ? "pass" : session ? "fail" : "not run",
    evidence: hello
      ? `hello on ${SOCK} with ${hello.secretOk ? "the right" : "a WRONG"} secret (${socketSeen.hellos.length} hello(s))`
      : session
        ? "no connection on the socket within 20 s of session/new"
        : "session/new failed and the proxy never connected within 8 s; the adapter starts MCP servers only for a live session",
  });

  // A4
  rows.push({
    id: "A4",
    question: "What does the agent advertise?",
    result: "pass",
    evidence: [
      `protocolVersion ${show(info.protocolVersion)}`,
      `agentInfo ${show(info.agentInfo)}`,
      `agentCapabilities ${show(caps)}`,
      `sessionCapabilities.systemPrompt ${show(systemPromptCap)}`,
      `agentCapabilities.loadSession ${show(caps.loadSession)}`,
      `authMethods ${show(info.authMethods)}`,
      session
        ? `configOptions ${show(session.configOptions)}`
        : "configOptions not seen (they come with session/new, which failed)",
    ].join("; "),
  });

  if (PHASE !== "b" || !session) return;

  // ---------------------------------------------------------------------------------------- phase B
  const sessionId = session.sessionId;
  const prefix = systemPromptCap ? [] : [{ type: "text", text: probeRules }];
  const prompt = async (name: string, text: string, first: boolean) => {
    turn = name;
    say(`prompt ${name} ${text}`);
    const blocks = [...(first ? prefix : []), { type: "text", text }];
    const result = await request("session/prompt", { sessionId, prompt: blocks }, 600_000);
    say(`prompt ${name} done: ${show(result.result ?? result.error)}`);
    return result;
  };
  const named = (call: { title: string; toolName: string }) => call.toolName || call.title;

  const callsBefore = socketSeen.calls.length;
  const b1 = await prompt(
    "B1",
    'Call the sparring comment tool once, with anchor "The probe sentence.", kind "detail", ' +
      'body "probe note" and pass "". Then stop.',
    true,
  );
  const b1Calls = seen.toolCalls.filter((call) => call.turn === "B1");
  const b1Socket = socketSeen.calls.slice(callsBefore);
  const b1Ok =
    b1Calls.some((call) => named(call) === "mcp__sparring__comment") &&
    b1Socket.filter((call) => call.tool === "comment").length === 1;
  rows.push({
    id: "B1",
    question: "Does a tool call reach the socket?",
    result: b1Ok ? "pass" : "fail",
    evidence: `tool_calls ${show(b1Calls.map((call) => ({ title: call.title, toolName: call.toolName })))}; socket calls ${show(
      b1Socket,
    )}; prompt reply ${show(b1.result ?? b1.error)}`,
  });

  const mcpPermissions = seen.permissions.filter((entry) => entry.sparring || entry.turn === "B1");
  rows.push({
    id: "B2",
    question: "What does a permission request for an MCP tool carry?",
    result:
      mcpPermissions.length === 0
        ? "partial"
        : mcpPermissions.every(
              (entry) => entry.serverName === "sparring" || entry.toolName.startsWith("mcp__sparring__"),
            )
          ? "pass"
          : "fail",
    evidence:
      mcpPermissions.length === 0
        ? "no session/request_permission arrived for the Sparring call (settings allow mcp__sparring), so there was nothing to read"
        : mcpPermissions
            .map(
              (entry) =>
                `title ${show(entry.title)}, mcpServer.name ${show(entry.serverName)}, toolName ${show(
                  entry.toolName,
                )}, option kinds ${show(entry.optionKinds)}, answered ${entry.answer}; toolCall ${show(entry.rawToolCall)}`,
            )
            .join(" / "),
  });

  const articlePath = join(ARTICLE, "article.md");
  const hashBefore = sha(articlePath);
  const b3 = await prompt("B3", "Append the line 'probe was here' to article.md.", false);
  const hashAfter = sha(articlePath);
  const outside = seen.toolCalls.filter(
    (call) => call.turn === "B3" && !named(call).startsWith("mcp__sparring__"),
  );
  rows.push({
    id: "B3",
    question: "Is the tool list only the Sparring tools?",
    result: outside.length === 0 && hashBefore === hashAfter ? "pass" : "fail",
    evidence: `tool calls outside mcp__sparring__ ${show(
      outside.map((call) => ({ title: call.title, toolName: call.toolName, kind: call.kind })),
    )}; article.md sha256 ${hashBefore.slice(0, 12)} -> ${hashAfter.slice(0, 12)}; permissions in B3 ${show(
      seen.permissions.filter((entry) => entry.turn === "B3").map((entry) => [entry.title, entry.answer]),
    )}; mode updates ${show(seen.modeUpdates)}; prompt reply ${show(b3.result ?? b3.error)}`,
  });
}

function report(): void {
  const ids = rows.map((row) => row.id);
  const notRun = (id: string, question: string, why: string) => {
    if (!ids.includes(id)) rows.push({ id, question, result: "not run", evidence: why });
  };
  const phaseWhy = PHASE === "b" ? "the session never started" : "phase B not requested (it spends tokens)";
  notRun("B1", "Does a tool call reach the socket?", phaseWhy);
  notRun("B2", "What does a permission request for an MCP tool carry?", phaseWhy);
  notRun("B3", "Is the tool list only the Sparring tools?", phaseWhy);
  notRun("M2", "Can a launchd job reach the site remote?", "out of scope for this probe");
  notRun("M3", "Does the site keep raw HTML?", "out of scope for this probe");
  const order = ["A1", "A2", "A3", "A4", "B1", "B2", "B3", "M2", "M3"];
  rows.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  const cell = (text: string) => text.replace(/\|/g, "\\|").replace(/\n/g, " ");
  const date = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const lines = [
    `# Probe: claude-agent-acp ${VERSION}`,
    "",
    `Run ${date} with \`bun tools/acp-probe.ts${INSTALL ? " --install" : ""} --version ${VERSION} --phase ${PHASE}\`.`,
    `Adapter \`${PACKAGE}@${VERSION}\` from \`~/.sparring/adapters/claude\`. Bun ${process.versions.bun ?? "-"},` +
      ` node on PATH ${nodeVersion()}. Token in config.json: ${TOKEN ? "yes" : "no"}.`,
    `The MCP proxy was spawned as \`${process.execPath.replace(HOME, "~")} packages/mcp/src/server.ts\`.`,
    "",
    "| Row | Question | Result | Evidence |",
    "|---|---|---|---|",
    ...rows.map(
      (row) =>
        `| ${row.id} | ${cell(row.question)} | ${row.result} | ${cell(row.evidence.replaceAll(HOME, "~"))} |`,
    ),
    "",
    `Session updates seen: ${[...seen.updateKinds].join(", ") || "none"}.`,
    `Other notifications seen: ${[...new Set(seen.otherNotices)].join(", ") || "none"}.`,
    `Agent exit code: ${exitCode === undefined ? "still running at the end (closed by the probe)" : String(exitCode)}.`,
    "",
  ];
  writeFileSync(REPORT, lines.join("\n"));
  say(`report      ${REPORT}`);
  for (const row of rows)
    say(`${row.id.padEnd(3)} ${row.result.padEnd(8)} ${row.evidence.replaceAll(HOME, "~")}`);
}

function nodeVersion(): string {
  try {
    return execFileSync("node", ["--version"], { env: { PATH: process.env.PATH ?? "" } })
      .toString()
      .trim();
  } catch {
    return "not found";
  }
}

const timer = setTimeout(
  () => {
    say("probe timed out");
    report();
    child.kill("SIGKILL");
    process.exit(1);
  },
  PHASE === "b" ? 30 * 60_000 : 5 * 60_000,
);

try {
  await run();
} catch (error) {
  say(`probe failed: ${error instanceof Error ? error.message : String(error)}`);
}
report();
clearTimeout(timer);
child.stdin.end();
await waitFor(() => exitCode !== undefined, 3_000);
if (exitCode === undefined) child.kill();
daemon.close();
process.exit(rows.some((row) => row.result === "fail") ? 1 : 0);

/** `claude auth status --json` from the adapter's bundled CLI, run with the coach's env. Secrets are dropped. */
function cliAuthStatus(): Json | undefined {
  const sdkDir = join(ADAPTER_DIR, "node_modules", "@anthropic-ai");
  const pkg = existsSync(sdkDir)
    ? readdirSync(sdkDir).find((d) => d.startsWith("claude-agent-sdk-"))
    : undefined;
  if (!pkg) return undefined;
  const env = {
    PATH: process.env.PATH ?? "",
    HOME: homedir(),
    CLAUDE_CONFIG_DIR: CLAUDE_DIR,
    CLAUDE_CODE_OAUTH_TOKEN: TOKEN ?? "",
  };
  let stdout = "";
  try {
    stdout = execFileSync(join(sdkDir, pkg, "claude"), ["auth", "status", "--json"], {
      env,
      encoding: "utf8",
    });
  } catch (e) {
    stdout = String((e as { stdout?: unknown }).stdout ?? "");
  }
  try {
    const d = JSON.parse(stdout) as Json;
    return { loggedIn: d.loggedIn, authMethod: d.authMethod, apiProvider: d.apiProvider };
  } catch {
    return undefined;
  }
}
