import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import type { EmbeddedContextFile } from "../pi-embedded-helpers.js";
import { validateAnthropicTurns } from "../pi-embedded-helpers.js";
import { buildPersonaPreambleMessage, splitPersonaContextFiles } from "./persona-preamble.js";

const soul: EmbeddedContextFile = { path: "SOUL.md", content: "be warm and casual" };
const agents: EmbeddedContextFile = { path: "AGENTS.md", content: "this folder is home" };
const user: EmbeddedContextFile = { path: "USER.md", content: "the owner is Alex" };
const memory: EmbeddedContextFile = { path: "MEMORY.md", content: "remembered facts" };

describe("splitPersonaContextFiles", () => {
  it("separates SOUL.md and AGENTS.md from the remaining files", () => {
    const { personaFiles, remainingFiles } = splitPersonaContextFiles([agents, soul, user, memory]);
    expect(personaFiles.map((f) => f.path)).toEqual(["SOUL.md", "AGENTS.md"]);
    expect(remainingFiles.map((f) => f.path)).toEqual(["USER.md", "MEMORY.md"]);
  });

  it("emits persona files in canonical order regardless of load order", () => {
    // Load order here is SOUL then AGENTS; canonical order is SOUL then AGENTS too,
    // but verify a reversed input still yields the canonical order.
    const { personaFiles } = splitPersonaContextFiles([agents, soul]);
    expect(personaFiles.map((f) => f.path)).toEqual(["SOUL.md", "AGENTS.md"]);
  });

  it("preserves the original order of the remaining files", () => {
    const { remainingFiles } = splitPersonaContextFiles([user, agents, memory, soul]);
    expect(remainingFiles.map((f) => f.path)).toEqual(["USER.md", "MEMORY.md"]);
  });

  it("matches persona files case-insensitively and by basename with directories", () => {
    const nested: EmbeddedContextFile = { path: "workspace/soul.md", content: "nested soul" };
    const { personaFiles, remainingFiles } = splitPersonaContextFiles([nested, user]);
    expect(personaFiles.map((f) => f.path)).toEqual(["workspace/soul.md"]);
    expect(remainingFiles.map((f) => f.path)).toEqual(["USER.md"]);
  });

  it("returns no persona files when none are present", () => {
    const { personaFiles, remainingFiles } = splitPersonaContextFiles([user, memory]);
    expect(personaFiles).toEqual([]);
    expect(remainingFiles.map((f) => f.path)).toEqual(["USER.md", "MEMORY.md"]);
  });
});

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
});
