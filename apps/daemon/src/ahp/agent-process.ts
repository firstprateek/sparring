// An ACP agent's stdio, however it was started: a child process, or the scripted coach running in process.
import type { Readable, Writable } from "node:stream";

export interface AgentProcess {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  kill(): void;
  /** Resolves with the exit code when the process ends. */
  exited: Promise<number | null>;
}

export interface LaunchRequest {
  articleId: string;
  /** The article's folder, absolute: the agent's working directory. */
  cwd: string;
  /** The allow-listed environment for the child. Never written anywhere. */
  env: Record<string, string>;
}

/** Starts one agent for one article. A scripted agent may answer at once. */
export type Launch = (r: LaunchRequest) => AgentProcess | Promise<AgentProcess>;
