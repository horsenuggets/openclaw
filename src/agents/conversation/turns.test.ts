import { describe, expect, it } from "vitest";
import {
  type ChatMessage,
  parseTurnContent,
  renderForWire,
  serializeTurnContent,
  stackConversation,
  toWireTurns,
  type WireTurn,
} from "./turns.js";

const u = (text: string, extra?: Partial<ChatMessage>): ChatMessage => ({
  role: "user",
  text,
  ...extra,
});
const a = (text: string, extra?: Partial<ChatMessage>): ChatMessage => ({
  role: "agent",
  text,
  ...extra,
});
const s = (text: string): ChatMessage => ({ role: "system", text });

/** Assert an alternating, user-first turn list (the API's hard requirements). */
function assertWellFormed(wire: WireTurn[]): void {
  if (wire.length === 0) {
    return;
  }
  expect(wire[0].role).toBe("user");
  for (let i = 1; i < wire.length; i += 1) {
    expect(wire[i].role).not.toBe(wire[i - 1].role);
  }
}

describe("stackConversation", () => {
  it("returns no turns for an empty conversation", () => {
    expect(stackConversation([])).toEqual({ systemText: undefined, turns: [] });
  });

  it("keeps a single user message as one turn", () => {
    const result = stackConversation([u("hi")]);
    expect(result.turns).toEqual([{ role: "user", messages: [u("hi")] }]);
  });

  it("merges consecutive user messages into one turn", () => {
    const result = stackConversation([u("one"), u("two"), u("three")]);
    expect(result.turns).toHaveLength(1);
    expect(result.turns[0].messages.map((m) => m.text)).toEqual(["one", "two", "three"]);
  });

  it("merges consecutive agent messages into one turn (proactive stacking)", () => {
    const result = stackConversation([a("good luck!"), a("how was the exam?")]);
    expect(result.turns).toHaveLength(1);
    expect(result.turns[0].role).toBe("agent");
    expect(result.turns[0].messages.map((m) => m.text)).toEqual([
      "good luck!",
      "how was the exam?",
    ]);
  });

  it("keeps alternating messages as separate turns", () => {
    const result = stackConversation([u("hi"), a("hello"), u("bye")]);
    expect(result.turns.map((t) => t.role)).toEqual(["user", "agent", "user"]);
  });

  it("lifts system entries out and does not break the surrounding user run", () => {
    const result = stackConversation([u("one"), s("persona"), u("two")]);
    expect(result.systemText).toBe("persona");
    expect(result.turns).toHaveLength(1);
    expect(result.turns[0].messages.map((m) => m.text)).toEqual(["one", "two"]);
  });

  it("joins multiple system entries with a blank line", () => {
    const result = stackConversation([s("first"), s("second"), u("hi")]);
    expect(result.systemText).toBe("first\n\nsecond");
  });

  it("ignores whitespace-only system entries", () => {
    const result = stackConversation([s("   \n "), u("hi")]);
    expect(result.systemText).toBeUndefined();
  });

  it("handles a conversation that is only system entries", () => {
    const result = stackConversation([s("persona")]);
    expect(result).toEqual({ systemText: "persona", turns: [] });
  });
});

describe("serializeTurnContent (storage form)", () => {
  it("stores a lone message with no metadata as plain text", () => {
    expect(serializeTurnContent([u("hi")])).toBe("hi");
  });

  it("stores a lone message WITH metadata as JSON", () => {
    expect(serializeTurnContent([u("hi", { ts: 5, from: "alex" })])).toBe(
      JSON.stringify([{ ts: 5, from: "alex", text: "hi" }]),
    );
  });

  it("stores stacked messages as a JSON array in fixed key order", () => {
    expect(serializeTurnContent([a("one", { ts: 1 }), a("two", { ts: 2 })])).toBe(
      JSON.stringify([
        { ts: 1, text: "one" },
        { ts: 2, text: "two" },
      ]),
    );
  });

  it("stores a stacked run with no metadata as JSON (not plain)", () => {
    expect(serializeTurnContent([u("one"), u("two")])).toBe(
      JSON.stringify([{ text: "one" }, { text: "two" }]),
    );
  });

  it("is deterministic for the same input (stable for prompt caching)", () => {
    const msgs = [u("one", { ts: 1, from: "x" }), u("two", { ts: 2 })];
    expect(serializeTurnContent(msgs)).toBe(serializeTurnContent(msgs));
  });
});

describe("parseTurnContent (read storage back, fill defaults)", () => {
  it("treats a plain string as a single message with the given role", () => {
    expect(parseTurnContent("hi", "user")).toEqual([{ role: "user", text: "hi" }]);
  });

  it("parses the JSON array form and attaches the role", () => {
    expect(parseTurnContent(JSON.stringify([{ ts: 5, from: "alex", text: "hi" }]), "user")).toEqual(
      [{ role: "user", text: "hi", ts: 5, from: "alex" }],
    );
  });

  it("treats malformed JSON as a single plain message (never throws)", () => {
    expect(parseTurnContent("{ not valid json", "agent")).toEqual([
      { role: "agent", text: "{ not valid json" },
    ]);
  });

  it("treats non-message JSON (e.g. a bare array of numbers) as plain text", () => {
    expect(parseTurnContent("[1,2,3]", "user")).toEqual([{ role: "user", text: "[1,2,3]" }]);
  });

  it("round-trips a lone no-metadata message", () => {
    const msgs = [u("hi")];
    expect(parseTurnContent(serializeTurnContent(msgs), "user")).toEqual(msgs);
  });

  it("round-trips a stacked run with metadata", () => {
    const msgs = [a("one", { ts: 1, from: "bot" }), a("two", { ts: 2 })];
    expect(parseTurnContent(serializeTurnContent(msgs), "agent")).toEqual(msgs);
  });

  it("round-trips a lone message whose text is itself a stored-message array (no corruption)", () => {
    // The text collides with the JSON storage shape; it must be stored as JSON
    // so parsing returns the original text verbatim, not the nested payload.
    const msgs = [u('[{"text":"nested"}]')];
    const stored = serializeTurnContent(msgs);
    expect(parseTurnContent(stored, "user")).toEqual(msgs);
  });

  it("round-trips a lone message whose text is a JSON array of message objects with metadata", () => {
    const msgs = [a('[{"ts":9,"from":"x","text":"hi"}]')];
    expect(parseTurnContent(serializeTurnContent(msgs), "agent")).toEqual(msgs);
  });

  it("round-trips an explicit empty-string from (preserves defined metadata)", () => {
    const msgs = [u("hi", { from: "" })];
    expect(parseTurnContent(serializeTurnContent(msgs), "user")).toEqual(msgs);
  });
});

describe("renderForWire (natural text for the API, never JSON)", () => {
  it("renders a lone message as its text", () => {
    expect(renderForWire([u("hi")])).toBe("hi");
  });

  it("joins stacked messages with a blank line and emits no JSON", () => {
    const rendered = renderForWire([a("good luck!"), a("how was the exam?")]);
    expect(rendered).toBe("good luck!\n\nhow was the exam?");
    expect(rendered).not.toContain("[");
    expect(rendered).not.toContain("{");
  });

  it("does not leak metadata syntax into the wire content", () => {
    const rendered = renderForWire([u("hi", { ts: 5, from: "alex" })]);
    expect(rendered).toBe("hi");
  });
});

describe("toWireTurns", () => {
  it("returns nothing for an empty conversation", () => {
    expect(toWireTurns(stackConversation([]))).toEqual([]);
  });

  it("maps a simple exchange to alternating natural-text turns", () => {
    const wire = toWireTurns(stackConversation([u("hi"), a("hello"), u("bye")]));
    expect(wire).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
      { role: "user", content: "bye" },
    ]);
    assertWellFormed(wire);
  });

  it("renders a stacked agent turn as natural paragraphs, not JSON", () => {
    const wire = toWireTurns(stackConversation([u("hi"), a("good luck!"), a("how was it?")]));
    expect(wire[1]).toEqual({ role: "assistant", content: "good luck!\n\nhow was it?" });
    expect(wire[1].content).not.toContain("{");
    assertWellFormed(wire);
  });

  it("prepends a bootstrap user turn when the conversation opens on an agent turn", () => {
    const wire = toWireTurns(stackConversation([a("proactive ping"), u("oh hi")]));
    expect(wire[0]).toEqual({ role: "user", content: "(conversation start)" });
    expect(wire.map((t) => t.role)).toEqual(["user", "assistant", "user"]);
    assertWellFormed(wire);
  });

  it("uses a custom bootstrap text when provided", () => {
    const wire = toWireTurns(stackConversation([a("ping")]), { bootstrapText: "(start)" });
    expect(wire[0].content).toBe("(start)");
    assertWellFormed(wire);
  });

  it("merges the system reminder into the first user turn (no user/user pair)", () => {
    const wire = toWireTurns(stackConversation([s("you are OpenClaw"), u("hi")]));
    expect(wire).toHaveLength(1);
    expect(wire[0].role).toBe("user");
    expect(wire[0].content).toBe("<system-reminder>\nyou are OpenClaw\n</system-reminder>\n\nhi");
    assertWellFormed(wire);
  });

  it("emits the system reminder as its own leading user turn when the first turn is an agent", () => {
    const wire = toWireTurns(stackConversation([s("you are OpenClaw"), a("proactive ping")]));
    expect(wire.map((t) => t.role)).toEqual(["user", "assistant"]);
    expect(wire[0].content).toContain("<system-reminder>");
    assertWellFormed(wire);
  });

  it("emits a lone system reminder as a single user turn", () => {
    const wire = toWireTurns(stackConversation([s("you are OpenClaw")]));
    expect(wire).toEqual([
      { role: "user", content: "<system-reminder>\nyou are OpenClaw\n</system-reminder>" },
    ]);
  });

  it("stays well-formed across a messy interleaved sequence", () => {
    const wire = toWireTurns(
      stackConversation([
        s("persona"),
        u("one"),
        u("two"),
        a("reply"),
        a("and a proactive follow-up"),
        u("three"),
        s("mid reminder"),
        u("four"),
      ]),
    );
    expect(wire.map((t) => t.role)).toEqual(["user", "assistant", "user"]);
    assertWellFormed(wire);
  });

  it("guarantees well-formedness for every small role permutation", () => {
    const roles: Array<ChatMessage["role"]> = ["user", "agent", "system"];
    const make = (r: ChatMessage["role"], i: number): ChatMessage =>
      r === "user" ? u(`u${i}`) : r === "agent" ? a(`a${i}`) : s(`s${i}`);
    for (const first of roles) {
      for (const second of roles) {
        for (const third of roles) {
          for (const len of [1, 2, 3]) {
            const seq = [first, second, third].slice(0, len).map((r, i) => make(r, i));
            assertWellFormed(toWireTurns(stackConversation(seq)));
          }
        }
      }
    }
  });
});
