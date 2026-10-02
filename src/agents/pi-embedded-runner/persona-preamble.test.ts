import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import type { EmbeddedContextFile } from "../pi-embedded-helpers.js";
import { validateAnthropicTurns } from "../pi-embedded-helpers.js";
import { buildPersonaPreambleMessage } from "./persona-preamble.js";

const soul: EmbeddedContextFile = { path: "SOUL.md", content: "be warm and casual" };
const agents: EmbeddedContextFile = { path: "AGENTS.md", content: "this folder is home" };

// The preamble content is a text-content array (never a bare string) so the turn
// validators preserve it when merging into a persisted user turn; join the text
// blocks to assert on the rendered content.
const textOf = (message: AgentMessage | undefined): string | undefined => {
  if (!message || !Array.isArray(message.content)) {
    return undefined;
  }
  return message.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("");
};

const contentOf = (files: EmbeddedContextFile[]): string | undefined =>
  textOf(buildPersonaPreambleMessage(files));

describe("buildPersonaPreambleMessage", () => {
  it("uses a text-content array so turn merging preserves it", () => {
    const message = buildPersonaPreambleMessage([soul, agents]);
    expect(Array.isArray(message?.content)).toBe(true);
    expect(message?.content).toEqual([
      { type: "text", text: expect.stringContaining("<system-reminder>") },
    ]);
  });

  it("survives merging into a persisted user turn on an ongoing session", () => {
    // On ongoing Anthropic sessions the preamble leads the persisted history and
    // is merged into the first user turn by validateAnthropicTurns. Array-shaped
    // content is required; a bare string would be dropped by the merge.
    const preamble = buildPersonaPreambleMessage([soul, agents]);
    expect(preamble).toBeDefined();
    const priorUser: AgentMessage = {
      role: "user",
      content: [{ type: "text", text: "hello there" }],
      timestamp: 1,
    } as AgentMessage;
    const [merged] = validateAnthropicTurns([preamble as AgentMessage, priorUser]);
    const mergedText = textOf(merged);
    expect(mergedText).toContain("You are OpenClaw");
    expect(mergedText).toContain("be warm and casual");
    expect(mergedText).toContain("hello there");
  });

  it("returns a user message wrapping the identity line and persona sections", () => {
    const message = buildPersonaPreambleMessage([soul, agents]);
    expect(message?.role).toBe("user");
    const content = contentOf([soul, agents]);
    expect(content).toContain("<system-reminder>");
    expect(content).toContain("</system-reminder>");
    expect(content).toContain("You are OpenClaw");
    expect(content).toContain("not Claude Code");
    expect(content).toContain("## SOUL.md");
    expect(content).toContain("be warm and casual");
    expect(content).toContain("## AGENTS.md");
    expect(content).toContain("this folder is home");
  });

  it("returns undefined when there are no persona files", () => {
    expect(buildPersonaPreambleMessage([])).toBeUndefined();
  });

  it("returns undefined when persona files are empty/whitespace", () => {
    expect(buildPersonaPreambleMessage([{ path: "SOUL.md", content: "   \n  " }])).toBeUndefined();
  });

  it("is deterministic for the same input (stable for prompt caching)", () => {
    expect(contentOf([soul, agents])).toEqual(contentOf([soul, agents]));
  });

  it("returns undefined when there is neither persona nor pointer content", () => {
    expect(buildPersonaPreambleMessage([], { pointer: "   " })).toBeUndefined();
  });

  it("renders non-persona preamble files without the identity line", () => {
    const userFile: EmbeddedContextFile = { path: "USER.md", content: "the owner is Alex" };
    const content = textOf(buildPersonaPreambleMessage([userFile]));
    expect(content).toContain("## USER.md");
    expect(content).toContain("the owner is Alex");
    // No SOUL/AGENTS present, so the persona identity line is omitted.
    expect(content).not.toContain("You are OpenClaw");
  });

  it("appends the pointer block inside the same system-reminder", () => {
    const pointer = "## Workspace Files\nThese exist: TOOLS.md, MEMORY.md. Read them when needed.";
    const content = textOf(buildPersonaPreambleMessage([soul], { pointer }));
    expect(content).toContain("## SOUL.md");
    expect(content).toContain("TOOLS.md, MEMORY.md");
    expect(content?.match(/<system-reminder>/g)?.length).toBe(1);
  });
});
