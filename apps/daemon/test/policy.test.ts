// policy.ts answers every session/request_permission (design section 3, the guard, layer 3).
import { describe, expect, it } from "vitest";
import { decide, isSparringCall } from "../src/policy.ts";

const ALL = [
  { optionId: "a1", name: "Allow once", kind: "allow_once" },
  { optionId: "aa", name: "Always allow", kind: "allow_always" },
  { optionId: "r1", name: "Reject", kind: "reject_once" },
  { optionId: "ra", name: "Always reject", kind: "reject_always" },
];
const byMeta = (toolName: string) => ({
  toolCallId: "t",
  title: "something the adapter calls it",
  _meta: { claudeCode: { toolName, mcpServer: { name: "sparring" } } },
});

describe("policy", () => {
  it("allows a Sparring call named by its MCP server with the offered allow_once", () => {
    const d = decide({ toolCall: byMeta("mcp__sparring__note_brief"), options: ALL });
    expect(d.result).toEqual({ outcome: { outcome: "selected", optionId: "a1" } });
    expect(d).toMatchObject({ allowed: true, sparring: true, tool: "note_brief", picked: "allow_once" });
  });

  it("falls back to the mcp__sparring__ name prefix, in _meta or the title", () => {
    expect(decide({ toolCall: { title: "mcp__sparring__read_article" }, options: ALL }).result).toEqual({
      outcome: { outcome: "selected", optionId: "a1" },
    });
    const viaToolName = {
      title: "Read article",
      _meta: { claudeCode: { toolName: "mcp__sparring__read_source" } },
    };
    expect(decide({ toolCall: viaToolName, options: ALL })).toMatchObject({
      allowed: true,
      tool: "read_source",
    });
    // another server's tool is not a Sparring call
    expect(
      isSparringCall({ title: "mcp__other__x", _meta: { claudeCode: { mcpServer: { name: "other" } } } }),
    ).toBe(false);
    expect(isSparringCall({ title: "Edit article.md" })).toBe(false);
  });

  it("rejects anything else with reject_once when it is offered", () => {
    const d = decide({ toolCall: { title: "Edit article.md", kind: "edit" }, options: ALL });
    expect(d.result).toEqual({ outcome: { outcome: "selected", optionId: "r1" } });
    expect(d).toMatchObject({ allowed: false, sparring: false, picked: "reject_once" });
  });

  it("rejects with reject_always when that is the only reject on offer", () => {
    const options = ALL.filter((o) => o.kind !== "reject_once");
    expect(decide({ toolCall: { title: "Bash" }, options }).result).toEqual({
      outcome: { outcome: "selected", optionId: "ra" },
    });
  });

  it("answers cancelled when no reject is offered", () => {
    const options = ALL.filter((o) => o.kind.startsWith("allow"));
    expect(decide({ toolCall: { title: "Write" }, options }).result).toEqual({
      outcome: { outcome: "cancelled" },
    });
    expect(decide({ toolCall: { title: "Write" } }).result).toEqual({ outcome: { outcome: "cancelled" } });
  });

  it("never answers allow_always, even for a Sparring call that is offered nothing else to allow", () => {
    const always = [ALL[1], ALL[2]] as typeof ALL;
    const d = decide({ toolCall: byMeta("mcp__sparring__note_brief"), options: always });
    expect(d.result).toEqual({ outcome: { outcome: "selected", optionId: "r1" } });
    expect(d.allowed).toBe(false);
    const only = decide({ toolCall: byMeta("mcp__sparring__note_brief"), options: [ALL[1]] });
    expect(only.result).toEqual({ outcome: { outcome: "cancelled" } });
    for (const toolCall of [byMeta("mcp__sparring__comment"), { title: "Edit" }, { title: "Bash" }]) {
      const r = decide({ toolCall, options: ALL }).result.outcome;
      expect(r.outcome === "selected" ? r.optionId : "").not.toBe("aa");
    }
  });

  it("never sends an optionId that was not offered", () => {
    const odd = [
      { optionId: "", kind: "allow_once" },
      { kind: "reject_once" },
      { optionId: 7, kind: "reject_once" },
      { optionId: "keep", kind: "reject_always" },
    ];
    const d = decide({ toolCall: { title: "Edit" }, options: odd });
    expect(d.result).toEqual({ outcome: { outcome: "selected", optionId: "keep" } });
    const s = decide({ toolCall: byMeta("mcp__sparring__note_brief"), options: odd });
    expect(s.result).toEqual({ outcome: { outcome: "selected", optionId: "keep" } });
    for (const options of [ALL, odd, []]) {
      for (const toolCall of [byMeta("mcp__sparring__x"), { title: "Edit" }]) {
        const r = decide({ toolCall, options }).result.outcome;
        if (r.outcome === "selected") expect(options.map((o) => o.optionId)).toContain(r.optionId);
      }
    }
  });

  it("allows write_draft only while a grant is live", () => {
    const call = byMeta("mcp__sparring__write_draft");
    expect(decide({ toolCall: call, options: ALL })).toMatchObject({ allowed: false, picked: "reject_once" });
    expect(decide({ toolCall: call, options: ALL }, { grantLive: true })).toMatchObject({
      allowed: true,
      picked: "allow_once",
    });
  });
});
