// Stores the Claude subscription token for the coach (design section 3, "Credentials").
//
//   claude setup-token            # prints a long-lived token
//   bun tools/set-claude-token.ts # paste it at the prompt (nothing is echoed)
//   pbpaste | bun tools/set-claude-token.ts
//
// It writes the token as `claude_oauth_token` into ~/.sparring/config.json (mode 0600, in a 0700
// directory) and keeps every other key. It never prints the token.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DIR = join(homedir(), ".sparring");
const CONFIG = join(DIR, "config.json");

function readPiped(): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      text += chunk;
    });
    process.stdin.on("end", () => resolve(text));
    process.stdin.on("error", reject);
  });
}

function readHidden(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    let text = "";
    process.stderr.write(prompt);
    stdin.setRawMode(true);
    stdin.setEncoding("utf8");
    stdin.resume();
    const finish = (error: Error | null) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("data", onData);
      process.stderr.write("\n");
      if (error) reject(error);
      else resolve(text);
    };
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === "\r" || char === "\n") return finish(null);
        if (char === "\u0003" || char === "\u0004") return finish(new Error("cancelled"));
        if (char === "\u007f" || char === "\b") text = text.slice(0, -1);
        else text += char;
      }
    };
    stdin.on("data", onData);
  });
}

async function main(): Promise<void> {
  const raw = process.stdin.isTTY
    ? await readHidden("paste the token from claude setup-token: ")
    : await readPiped();
  const token = raw.trim();
  if (!token || /\s/.test(token)) {
    console.error("no token stored: expected one token with no spaces");
    process.exit(1);
  }

  mkdirSync(DIR, { recursive: true, mode: 0o700 });
  chmodSync(DIR, 0o700);
  let config: Record<string, unknown> = {};
  if (existsSync(CONFIG)) {
    try {
      config = JSON.parse(readFileSync(CONFIG, "utf8")) as Record<string, unknown>;
    } catch {
      console.error(`no token stored: ${CONFIG} is not valid JSON; fix or remove it first`);
      process.exit(1);
    }
  }
  config.claude_oauth_token = token;
  const temp = `${CONFIG}.tmp-${process.pid}`;
  writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, CONFIG);
  console.error(`stored claude_oauth_token in ${CONFIG} (mode 0600)`);
}

main().catch((error: unknown) => {
  console.error(`no token stored: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
