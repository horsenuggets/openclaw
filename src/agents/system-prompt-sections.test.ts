import { describe, expect, it } from "vitest";
import {
  applyPromptTokens,
  loadSystemPromptSections,
  parseSystemPromptSections,
} from "./system-prompt-sections.js";

const SAMPLE = [
  "---",
  "summary: ignored front matter",
  "---",
  "",
  "<!-- a comment that must not leak -->",
  "",
  "# SYSTEM.md » title",
  "",
  "the identity line",
  "",
  "## tooling",
  "",
  "intro prose",
  "<!-- inline comment -->",
  "${toolList}",
  "trailing prose",
  "",
  "### message tool",
  "",
  "- pass `channel` (${messageChannelOptions})",
  "",
  "#### inline buttons disabled",
  "",
  "- not enabled for ${runtimeChannel}",
].join("\n");

describe("parseSystemPromptSections", () => {
  it("captures the intro line before the first heading", () => {
    const { intro } = parseSystemPromptSections(SAMPLE);
    expect(intro).toBe("the identity line");
  });

  it("keys sections by lowercased heading text across levels", () => {
    const { sections } = parseSystemPromptSections(SAMPLE);
    expect([...sections.keys()]).toEqual(["tooling", "message tool", "inline buttons disabled"]);
  });

  it("stores the verbatim heading (with its hashes) per section", () => {
    const { sections } = parseSystemPromptSections(SAMPLE);
    expect(sections.get("tooling")?.heading).toBe("## tooling");
    expect(sections.get("message tool")?.heading).toBe("### message tool");
    expect(sections.get("inline buttons disabled")?.heading).toBe("#### inline buttons disabled");
  });

  it("drops front matter, html comments, and blank lines from bodies", () => {
    const { sections } = parseSystemPromptSections(SAMPLE);
    // The comment lines and blank lines are gone; prose + token lines remain.
    expect(sections.get("tooling")?.lines).toEqual([
      "intro prose",
      "${toolList}",
      "trailing prose",
    ]);
  });

  it("leaves ${...} tokens byte-exact for the builder to fill", () => {
    const { sections } = parseSystemPromptSections(SAMPLE);
    expect(sections.get("message tool")?.lines[0]).toBe(
      "- pass `channel` (${messageChannelOptions})",
    );
  });

  it("rejects duplicate headings instead of silently overwriting", () => {
    const dup = "# title\n\nintro\n\n## safety\n\nreal\n\n## safety\n\nshadow\n";
    expect(() => parseSystemPromptSections(dup)).toThrow(/duplicate "safety" heading/);
  });
});

describe("applyPromptTokens", () => {
  it("substitutes known tokens and leaves unknown ones untouched", () => {
    expect(
      applyPromptTokens("dir `${workspaceDir}` and `${missing}`", { workspaceDir: "/w" }),
    ).toBe("dir `/w` and `${missing}`");
  });

  it("does not treat $ in the replacement as a special sequence", () => {
    expect(applyPromptTokens("${x}", { x: "$1 literal" })).toBe("$1 literal");
  });
});

describe("loadSystemPromptSections", () => {
  it("parses the embedded SYSTEM.md source", () => {
    const { intro, sections } = loadSystemPromptSections();
    expect(intro).toContain("you are openclaw");
    // The builder fails fast on a missing required section, so SYSTEM.md must
    // keep every key it requests. This is the full set.
    for (const key of [
      "tooling",
      "tool call style",
      "safety",
      "skills (mandatory)",
      "date and time",
      "workspace",
      "documentation",
      "workspace files (injected)",
      "first-run setup",
      "reply tags",
      "messaging",
      "proactive messaging",
      "message tool",
      "inline buttons enabled",
      "inline buttons disabled",
      "silent replies",
      "message priority",
      "output boundaries",
    ]) {
      expect(sections.has(key)).toBe(true);
    }
    // The builder fills these; the source must keep the tokens intact.
    expect(sections.get("tooling")?.lines).toContain("${toolList}");
    expect(sections.get("workspace")?.lines.join("\n")).toContain("${workspaceDir}");
  });
});
