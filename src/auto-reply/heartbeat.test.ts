import { describe, expect, it } from "vitest";
import {
  appendHeartbeatAck,
  HEARTBEAT_ACK_INSTRUCTION,
  HEARTBEAT_PROMPT,
  isHeartbeatContentEffectivelyEmpty,
} from "./heartbeat.js";
import { isSilentReplyText, SILENT_REPLY_TOKEN } from "./tokens.js";

describe("HEARTBEAT_PROMPT", () => {
  it("instructs the agent to acknowledge a no-op with only the silent-reply token", () => {
    expect(HEARTBEAT_PROMPT).toContain(SILENT_REPLY_TOKEN);
    expect(HEARTBEAT_PROMPT).toContain(HEARTBEAT_ACK_INSTRUCTION);
    // The silent-reply token the prompt asks for must itself read as a silent reply so the
    // auto-reply pipeline suppresses the ack on every channel.
    expect(isSilentReplyText(SILENT_REPLY_TOKEN, SILENT_REPLY_TOKEN)).toBe(true);
  });
});

describe("appendHeartbeatAck", () => {
  it("appends the ack instruction to a custom prompt that omits the silent token", () => {
    const custom = "Check Gmail PubSub stats and report anomalies.";
    const result = appendHeartbeatAck(custom);
    expect(result.startsWith(custom)).toBe(true);
    expect(result).toContain(SILENT_REPLY_TOKEN);
    expect(result).toContain(HEARTBEAT_ACK_INSTRUCTION);
  });

  it("does not duplicate the ack when the prompt already contains the instruction", () => {
    expect(appendHeartbeatAck(HEARTBEAT_PROMPT)).toBe(HEARTBEAT_PROMPT);
    expect(appendHeartbeatAck(`do a thing. ${HEARTBEAT_ACK_INSTRUCTION}`)).toBe(
      `do a thing. ${HEARTBEAT_ACK_INSTRUCTION}`,
    );
  });

  it("still appends when the prompt only mentions the token without the ack instruction", () => {
    // A prompt that references `⁘ return` for another reason (e.g. "report accidental
    // ⁘ return output") must not be mistaken for already carrying the ack instruction.
    const custom = `Report any accidental ${SILENT_REPLY_TOKEN} output in the logs.`;
    const result = appendHeartbeatAck(custom);
    expect(result.startsWith(custom)).toBe(true);
    expect(result).toContain(HEARTBEAT_ACK_INSTRUCTION);
  });
});

describe("isHeartbeatContentEffectivelyEmpty", () => {
  it("returns false for undefined/null (missing file should not skip)", () => {
    expect(isHeartbeatContentEffectivelyEmpty(undefined)).toBe(false);
    expect(isHeartbeatContentEffectivelyEmpty(null)).toBe(false);
  });

  it("returns true for empty string", () => {
    expect(isHeartbeatContentEffectivelyEmpty("")).toBe(true);
  });

  it("returns true for whitespace only", () => {
    expect(isHeartbeatContentEffectivelyEmpty("   ")).toBe(true);
    expect(isHeartbeatContentEffectivelyEmpty("\n\n\n")).toBe(true);
    expect(isHeartbeatContentEffectivelyEmpty("  \n  \n  ")).toBe(true);
    expect(isHeartbeatContentEffectivelyEmpty("\t\t")).toBe(true);
  });

  it("returns true for header-only content", () => {
    expect(isHeartbeatContentEffectivelyEmpty("# HEARTBEAT.md")).toBe(true);
    expect(isHeartbeatContentEffectivelyEmpty("# HEARTBEAT.md\n")).toBe(true);
    expect(isHeartbeatContentEffectivelyEmpty("# HEARTBEAT.md\n\n")).toBe(true);
  });

  it("returns true for comments only", () => {
    expect(isHeartbeatContentEffectivelyEmpty("# Header\n# Another comment")).toBe(true);
    expect(isHeartbeatContentEffectivelyEmpty("## Subheader\n### Another")).toBe(true);
  });

  it("returns true for HTML-comment-only content", () => {
    // The revamped HEARTBEAT.md template keeps its guidance in HTML comments,
    // and the template promises a comments-only file skips heartbeat calls.
    expect(isHeartbeatContentEffectivelyEmpty("<!-- keep this file empty -->")).toBe(true);
    expect(
      isHeartbeatContentEffectivelyEmpty(
        "# HEARTBEAT.md » workspace heartbeat\n\n<!-- keep this file empty (or with only comments) to skip heartbeat API calls -->\n<!-- add tasks below when you want the agent to check something periodically -->",
      ),
    ).toBe(true);
    // Multi-line comment blocks are skipped too.
    expect(isHeartbeatContentEffectivelyEmpty("<!--\nline one\nline two\n-->")).toBe(true);
    // Real content outside a comment is still actionable.
    expect(isHeartbeatContentEffectivelyEmpty("<!-- note -->\n- Check email")).toBe(false);
  });

  it("returns true for default template content (header + comment)", () => {
    const defaultTemplate = `# HEARTBEAT.md

Keep this file empty unless you want a tiny checklist. Keep it small.
`;
    // Note: The template has actual text content, so it's NOT effectively empty
    expect(isHeartbeatContentEffectivelyEmpty(defaultTemplate)).toBe(false);
  });

  it("returns true for header with only empty lines", () => {
    expect(isHeartbeatContentEffectivelyEmpty("# HEARTBEAT.md\n\n\n")).toBe(true);
  });

  it("returns false when actionable content exists", () => {
    expect(isHeartbeatContentEffectivelyEmpty("- Check email")).toBe(false);
    expect(isHeartbeatContentEffectivelyEmpty("# HEARTBEAT.md\n- Task 1")).toBe(false);
    expect(isHeartbeatContentEffectivelyEmpty("Remind me to call mom")).toBe(false);
  });

  it("returns false for content with tasks after header", () => {
    const content = `# HEARTBEAT.md

- Task 1
- Task 2
`;
    expect(isHeartbeatContentEffectivelyEmpty(content)).toBe(false);
  });

  it("returns false for mixed content with non-comment text", () => {
    const content = `# HEARTBEAT.md
## Tasks
Check the server logs
`;
    expect(isHeartbeatContentEffectivelyEmpty(content)).toBe(false);
  });

  it("treats markdown headers as comments (effectively empty)", () => {
    const content = `# HEARTBEAT.md
## Section 1
### Subsection
`;
    expect(isHeartbeatContentEffectivelyEmpty(content)).toBe(true);
  });
});
