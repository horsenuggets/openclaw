import { describe, expect, it } from "vitest";
import { parseAgentCommand, unescapeAgentText } from "./agent-commands.js";

describe("parseAgentCommand", () => {
  it("parses a bare command", () => {
    expect(parseAgentCommand("⁘ send_hook_embed welcome")).toEqual({
      command: "send_hook_embed",
      args: ["welcome"],
    });
  });

  it("parses the no-op command", () => {
    expect(parseAgentCommand("⁘ return")).toEqual({ command: "return", args: [] });
  });

  it("trims surrounding whitespace before detecting", () => {
    expect(parseAgentCommand("  ⁘ return  ")).toEqual({ command: "return", args: [] });
  });

  it("returns null for a normal message", () => {
    expect(parseAgentCommand("hey, what's up?")).toBeNull();
  });

  it("returns null for an escaped marker (not a command)", () => {
    expect(parseAgentCommand("\\⁘ this is text")).toBeNull();
  });

  it("requires the marker to be followed by a space", () => {
    // marker glued to text is not a command prefix
    expect(parseAgentCommand("⁘send_hook_embed")).toBeNull();
  });

  it("unwraps a command the model put in inline backticks", () => {
    expect(parseAgentCommand("`⁘ send_hook_embed welcome`")).toEqual({
      command: "send_hook_embed",
      args: ["welcome"],
    });
  });

  it("unwraps a command the model put in a fenced code block", () => {
    expect(parseAgentCommand("```\n⁘ send_hook_embed welcome\n```")).toEqual({
      command: "send_hook_embed",
      args: ["welcome"],
    });
  });

  it("tokenizes quoted args with spaces and escaped quotes", () => {
    const parsed = parseAgentCommand(
      '⁘ command arg1 arg2 arg3 "argument 4" "argument \\"5\\" with double-quotes"',
    );
    expect(parsed).toEqual({
      command: "command",
      args: ["arg1", "arg2", "arg3", "argument 4", 'argument "5" with double-quotes'],
    });
  });

  it("supports escaped backslashes inside quotes", () => {
    expect(parseAgentCommand('⁘ cmd "a\\\\b"')).toEqual({ command: "cmd", args: ["a\\b"] });
  });
});

describe("unescapeAgentText", () => {
  it("renders a single-escaped marker as the bare marker", () => {
    expect(unescapeAgentText("\\⁘ hello")).toBe("⁘ hello");
  });

  it("renders a double-escaped marker as backslash + marker", () => {
    expect(unescapeAgentText("\\\\⁘ hello")).toBe("\\⁘ hello");
  });

  it("collapses longer backslash runs (pairs collapse)", () => {
    expect(unescapeAgentText("\\\\\\⁘ x")).toBe("\\⁘ x"); // 3 -> 1 kept + marker
    expect(unescapeAgentText("\\\\\\\\⁘ x")).toBe("\\\\⁘ x"); // 4 -> 2 kept + marker
  });

  it("leaves normal text unchanged", () => {
    expect(unescapeAgentText("just a message")).toBe("just a message");
    expect(unescapeAgentText("⁘ command-looking but rendered as-is")).toBe(
      "⁘ command-looking but rendered as-is",
    );
  });
});
