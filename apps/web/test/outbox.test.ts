// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { Outbox, type OutboxStore } from "../src/outbox.ts";

function memoryStore(): OutboxStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

function rig() {
  const store = memoryStore();
  const sent: string[] = [];
  let open = false;
  const send = (text: string) => {
    if (!open) return false;
    sent.push(text);
    return true;
  };
  const box = new Outbox("sparring-outbox:a", send, store);
  return {
    store,
    sent,
    box,
    setOpen: (v: boolean) => {
      open = v;
    },
  };
}

describe("outbox", () => {
  it("keeps lines while the socket is closed, in storage", () => {
    const { box, sent, store } = rig();
    expect(box.push("first")).toBe("queued");
    expect(box.push("second")).toBe("queued");
    expect(sent).toEqual([]);
    expect(box.lines().map((l) => l.text)).toEqual(["first", "second"]);
    expect(JSON.parse(store.data.get("sparring-outbox:a") ?? "[]")).toHaveLength(2);
  });

  it("sends them once, in order, after the reconnect", () => {
    const { box, sent, store, setOpen } = rig();
    box.push("one");
    box.push("two");
    box.push("three");
    setOpen(true);
    expect(box.flush()).toBe(3);
    expect(sent).toEqual(["one", "two", "three"]);
    expect(box.flush()).toBe(0);
    expect(sent).toEqual(["one", "two", "three"]);
    expect(box.lines()).toEqual([]);
    expect(store.data.has("sparring-outbox:a")).toBe(false);
  });

  it("survives a reload: a new outbox on the same key sends what the old one kept", () => {
    const { box, store } = rig();
    box.push("kept");
    const sent: string[] = [];
    const again = new Outbox(
      "sparring-outbox:a",
      (t) => {
        sent.push(t);
        return true;
      },
      store,
    );
    expect(again.flush()).toBe(1);
    expect(sent).toEqual(["kept"]);
  });

  it("sends at once when open, and a new line waits behind older ones", () => {
    const { box, sent, setOpen } = rig();
    setOpen(true);
    expect(box.push("now")).toBe("sent");
    expect(sent).toEqual(["now"]);
    setOpen(false);
    box.push("later");
    setOpen(true);
    expect(box.push("after")).toBe("sent");
    expect(sent).toEqual(["now", "later", "after"]);
  });

  it("stops at the first refusal and keeps the rest in order", () => {
    const store = memoryStore();
    const sent: string[] = [];
    let budget = 0;
    const box = new Outbox(
      "k",
      (t) => {
        if (budget <= 0) return false;
        budget--;
        sent.push(t);
        return true;
      },
      store,
    );
    box.push("a");
    box.push("b");
    box.push("c");
    budget = 1;
    expect(box.flush()).toBe(1);
    expect(box.lines().map((l) => l.text)).toEqual(["b", "c"]);
    budget = 5;
    box.flush();
    expect(sent).toEqual(["a", "b", "c"]);
  });

  it("tells listeners when the waiting lines change", () => {
    const { box, setOpen } = rig();
    const seen: number[] = [];
    box.onChange((lines) => seen.push(lines.length));
    box.push("x");
    setOpen(true);
    box.flush();
    expect(seen).toEqual([1, 0]);
  });
});
