import { describe, expect, it } from "vitest";
import { isSilentReplyText, SILENT_REPLY_TOKEN } from "./tokens.js";

describe("isSilentReplyText", () => {
  it("detects the token as the whole message", () => {
    expect(isSilentReplyText(SILENT_REPLY_TOKEN)).toBe(true);
    expect(isSilentReplyText(`  ${SILENT_REPLY_TOKEN}`)).toBe(true);
    expect(isSilentReplyText(`${SILENT_REPLY_TOKEN} now`)).toBe(true);
  });

  it("detects the token as a trailing suffix after a delimiter", () => {
    // Regression: the token begins with the non-word marker U+2058, so a leading
    // `\b` word boundary never matches after a space and these were missed.
    expect(isSilentReplyText(`note ${SILENT_REPLY_TOKEN}`)).toBe(true);
    expect(isSilentReplyText(`done. ${SILENT_REPLY_TOKEN}`)).toBe(true);
    expect(isSilentReplyText(`line\n${SILENT_REPLY_TOKEN}`)).toBe(true);
  });

  it("does not match unrelated text", () => {
    expect(isSilentReplyText("")).toBe(false);
    expect(isSilentReplyText(undefined)).toBe(false);
    expect(isSilentReplyText("foo")).toBe(false);
    expect(isSilentReplyText("returning things")).toBe(false);
    expect(isSilentReplyText("a return")).toBe(false);
  });
});
