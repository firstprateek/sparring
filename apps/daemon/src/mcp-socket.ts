// The MCP listener: the Unix socket `~/.sparring/daemon.sock`, mode 0600 in a 0700 directory. It carries the MCP
// proxy's traffic and nothing else; nothing MCP-related is served on the HTTP port.
//
// The proxy sends one JSON object per line and reads one line back: `{secret, hello: true}` when it starts, then
// `{secret, tool, args}` per call. A secret the daemon did not give out gets one refusal and the socket is closed.
import { chmodSync, lstatSync, mkdirSync, rmSync, statSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import type { ToolReply, Tools } from "./tools.ts";

/** macOS caps a socket path at 104 bytes, the terminating NUL included. */
const PATH_MAX = 103;
const LINE_MAX = 1024 * 1024;

export interface McpSocket {
  readonly path: string;
  close(): Promise<void>;
}

export async function listenMcp(
  path: string,
  tools: Tools,
  log: (m: string) => void = () => {},
): Promise<McpSocket> {
  if (Buffer.byteLength(path) > PATH_MAX)
    throw new Error(`the socket path is longer than ${PATH_MAX} bytes: ${path}`);
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if ((statSync(dir).mode & 0o077) !== 0) chmodSync(dir, 0o700);
  // A socket left by a daemon that died; anything else at that path is not ours to remove.
  try {
    if (lstatSync(path).isSocket()) rmSync(path);
    else throw new Error(`${path} exists and is not a socket`);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const server: Server = createServer((socket) => serve(socket, tools, log));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.off("error", reject);
      resolve();
    });
  });
  chmodSync(path, 0o600);
  server.on("error", (e) => log(`mcp socket: ${e.message}`));
  return {
    path,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          rmSync(path, { force: true });
          resolve();
        });
      }),
  };
}

function serve(socket: Socket, tools: Tools, log: (m: string) => void): void {
  let buf = "";
  let chain = Promise.resolve();
  let done = false;
  const reply = (r: ToolReply | { ok: true }) => {
    if (!done && !socket.destroyed) socket.write(`${JSON.stringify(r)}\n`);
  };
  socket.setEncoding("utf8");
  socket.on("error", () => {});
  socket.on("data", (chunk: string) => {
    buf += chunk;
    if (buf.length > LINE_MAX) {
      reply({ ok: false, error: "line too long" });
      socket.destroy();
      return;
    }
    for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      // One line at a time, in order: a call's reply never overtakes the one before.
      chain = chain.then(() => handle(line));
    }
  });
  const handle = async (line: string): Promise<void> => {
    if (done || socket.destroyed) return;
    let m: Record<string, unknown>;
    try {
      m = JSON.parse(line) as Record<string, unknown>;
    } catch {
      reply({ ok: false, error: "not JSON" });
      return;
    }
    if (!tools.articleOf(m.secret)) {
      log("mcp socket: refused a connection with an unknown secret");
      reply({ ok: false, error: "unknown session secret" });
      done = true;
      socket.end();
      return;
    }
    if (m.hello === true) {
      tools.hello(m.secret);
      reply({ ok: true });
      return;
    }
    reply(await tools.call(m.secret, m.tool, m.args));
  };
}
