import type { ChatState } from "@microsoft/agent-host-protocol";
import { describe, expect, it } from "vitest";
import { chatOf, errorLine, metaOf, toolLine, transcript } from "../src/session.ts";

const turn = (over: Record<string, unknown>) => ({
  id: "t",
  startedAt: "2026-11-10T09:12:00.000Z",
  message: { text: "", origin: { kind: "user" } },
  responseParts: [],
  usage: undefined,
  state: "complete",
  ...over,
});

describe("transcript", () => {
  it("maps writer, coach, tool and host lines in order", () => {
    const chat = {
      turns: [
        turn({
          id: "a",
          message: { text: "the confident one", origin: { kind: "user" } },
          responseParts: [
            { kind: "markdown", id: "m1", content: "Say the claim " },
            { kind: "markdown", id: "m2", content: "in one sentence." },
            {
              kind: "toolCall",
              toolCall: {
                toolCallId: "x",
                toolName: "mcp__sparring__comment",
                displayName: "comment",
                status: "completed",
                pastTenseMessage: "c07 · unclear · ¶3",
              },
            },
          ],
        }),
        turn({
          id: "b",
          message: { text: "", origin: { kind: "systemNotification" } },
          responseParts: [{ kind: "systemNotification", content: "stage draft" }],
        }),
      ],
    } as unknown as ChatState;
    expect(transcript(chat).map((l) => [l.kind, l.text])).toEqual([
      ["you", "the confident one"],
      ["coach", "Say the claim in one sentence."],
      ["tool", "comment · c07 · unclear · ¶3"],
      ["host", "stage draft"],
    ]);
  });

  it("marks the running turn's reply as streaming", () => {
    const chat = {
      turns: [],
      activeTurn: turn({
        message: { text: "hi", origin: { kind: "user" } },
        responseParts: [{ kind: "markdown", id: "m", content: "Wh" }],
      }),
    } as unknown as ChatState;
    const last = transcript(chat).at(-1);
    expect(last?.kind === "coach" && last.streaming).toBe(true);
  });

  it("names a tool by its displayName when it is not a Sparring tool", () => {
    expect(toolLine({ toolName: "Edit", displayName: "Edit file", invocationMessage: "Edit file" })).toBe(
      "Edit file",
    );
  });
});

describe("summaries", () => {
  it("reads _meta.sparring and the default chat", () => {
    const s = {
      _meta: { sparring: { slug: "closed-laptop" } },
      chats: [{ resource: "ahp-chat:/1", title: "" }],
    };
    expect(metaOf(s)?.slug).toBe("closed-laptop");
    expect(metaOf({ _meta: { other: 1 } })).toBeUndefined();
    expect(chatOf(s as never)).toBe("ahp-chat:/1");
    expect(chatOf({ ...s, defaultChat: "ahp-chat:/2" } as never)).toBe("ahp-chat:/2");
  });
});

describe("errorLine", () => {
  it("shows a turn that failed for sign-in as `sign-in needed · claude`", () => {
    expect(errorLine({ errorType: "agent_error", message: "Authentication required" })).toBe(
      "sign-in needed · claude",
    );
    expect(errorLine({ errorType: "auth_required", message: "" })).toBe("sign-in needed · claude");
    expect(errorLine({ errorType: "agent_error", message: "-32000: no credential" })).toBe(
      "sign-in needed · claude",
    );
    expect(errorLine({ errorType: "sign_in", message: "sign-in needed · claude" })).toBe(
      "sign-in needed · claude",
    );
  });

  it("keeps other failures as `error · <message>`", () => {
    expect(errorLine({ errorType: "agent_exited", message: "the coach exited" })).toBe(
      "error · the coach exited",
    );
    expect(errorLine({ errorType: "agent_error", message: "an author note" })).toBe("error · an author note");
  });

  it("puts the sign-in line in the transcript like any host line", () => {
    const chat = {
      turns: [
        turn({
          message: { text: "hello", origin: { kind: "user" } },
          responseParts: [
            { kind: "error", error: { errorType: "agent_error", message: "Authentication required" } },
          ],
          state: "error",
        }),
      ],
      activeTurn: undefined,
      queuedMessages: [],
    } as unknown as ChatState;
    expect(transcript(chat).map((l) => [l.kind, l.text])).toEqual([
      ["you", "hello"],
      ["host", "sign-in needed · claude"],
    ]);
  });
});
