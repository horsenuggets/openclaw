import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import { toChatMessages } from "./transcript.js";

const userMsg = (text: string, ts?: number): AgentMessage =>
  ({ role: "user", content: text, timestamp: ts ?? 1 }) as AgentMessage;

const userBlocks = (text: string, ts?: number): AgentMessage =>
  ({ role: "user", content: [{ type: "text", text }], timestamp: ts ?? 1 }) as AgentMessage;

const assistantMsg = (
  content: Array<{ type: string; text?: string; thinking?: string }>,
  ts?: number,
): AgentMessage => ({ role: "assistant", content, timestamp: ts ?? 1 }) as AgentMessage;

const toolResult = (): AgentMessage =>
  ({
    role: "toolResult",
    toolCallId: "t1",
    toolName: "Read",
    content: [{ type: "text", text: "file contents" }],
    isError: false,
    timestamp: 1,
  }) as AgentMessage;

const reminder = (body: string): string => `<system-reminder>\n${body}\n</system-reminder>`;

describe("toChatMessages", () => {
  it("maps a plain user turn to a user message and preserves the timestamp", () => {
    expect(toChatMessages([userMsg("hi", 42)])).toEqual([{ role: "user", text: "hi", ts: 42 }]);
  });

  it("maps an assistant text turn to an agent message", () => {
    expect(toChatMessages([assistantMsg([{ type: "text", text: "hello" }], 7)])).toEqual([
      { role: "agent", text: "hello", ts: 7 },
    ]);
  });

  it("classifies a fully system-reminder-wrapped user turn as system (attribution)", () => {
    const [msg] = toChatMessages([userMsg(reminder("automated heartbeat check-in"))]);
    expect(msg.role).toBe("system");
    expect(msg.text).toContain("automated heartbeat check-in");
  });

  it("keeps a user turn that only STARTS with a reminder as a real user message", () => {
    // e.g. the persona preamble merged into a real user turn: reminder + human text.
    const merged = `${reminder("you are OpenClaw")}\n\nwhat's the weather?`;
    const [msg] = toChatMessages([userMsg(merged)]);
    expect(msg.role).toBe("user");
    expect(msg.text).toContain("what's the weather?");
  });

  it("reads user content from a text-block array", () => {
    expect(toChatMessages([userBlocks("hi", 3)])).toEqual([{ role: "user", text: "hi", ts: 3 }]);
  });

  it("joins multiple assistant text blocks and ignores thinking blocks", () => {
    const msg = assistantMsg([
      { type: "thinking", thinking: "internal reasoning" },
      { type: "text", text: "part one " },
      { type: "text", text: "part two" },
    ]);
    expect(toChatMessages([msg])).toEqual([{ role: "agent", text: "part one part two", ts: 1 }]);
  });

  it("drops assistant turns that carry no text (pure tool calls / thinking)", () => {
    const toolOnly = assistantMsg([{ type: "thinking", thinking: "deciding" }]) as AgentMessage & {
      content: unknown[];
    };
    (toolOnly.content as unknown[]).push({
      type: "toolCall",
      id: "t1",
      name: "Read",
      arguments: {},
    });
    expect(toChatMessages([toolOnly])).toEqual([]);
  });

  it("drops tool-result turns (internal context, not conversation)", () => {
    expect(toChatMessages([toolResult()])).toEqual([]);
  });

  it("drops empty/whitespace-only turns", () => {
    expect(toChatMessages([userMsg("   "), assistantMsg([{ type: "text", text: " " }])])).toEqual(
      [],
    );
  });

  it("preserves whitespace-significant assistant text without trimming", () => {
    const code = "here you go:\n\n    const x = 1;\n";
    expect(toChatMessages([assistantMsg([{ type: "text", text: code }], 1)])).toEqual([
      { role: "agent", text: code, ts: 1 },
    ]);
  });

  it("produces a coherent attributed view of a mixed conversation", () => {
    const view = toChatMessages([
      userMsg("book me a table", 1),
      assistantMsg([{ type: "text", text: "on it" }], 2),
      assistantMsg([{ type: "thinking", thinking: "x" }], 3), // no text → dropped
      toolResult(), // dropped
      userMsg(reminder("heartbeat: anything to do?"), 4), // synthetic → system
      assistantMsg([{ type: "text", text: "checking in — still free tonight?" }], 5),
    ]);
    expect(view).toEqual([
      { role: "user", text: "book me a table", ts: 1 },
      { role: "agent", text: "on it", ts: 2 },
      { role: "system", text: reminder("heartbeat: anything to do?"), ts: 4 },
      { role: "agent", text: "checking in — still free tonight?", ts: 5 },
    ]);
  });
});
