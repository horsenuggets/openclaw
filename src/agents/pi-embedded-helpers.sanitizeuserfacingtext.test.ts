import { describe, expect, it } from "vitest";
import { isRawApiErrorPayload, sanitizeUserFacingText } from "./pi-embedded-helpers.js";

describe("sanitizeUserFacingText", () => {
  it("strips final tags", () => {
    expect(sanitizeUserFacingText("<final>Hello</final>")).toBe("Hello");
    expect(sanitizeUserFacingText("Hi <final>there</final>!")).toBe("Hi there!");
  });

  it("does not clobber normal numeric prefixes", () => {
    expect(sanitizeUserFacingText("202 results found")).toBe("202 results found");
    expect(sanitizeUserFacingText("400 days left")).toBe("400 days left");
  });

  it("strips model artifact tags like </s>", () => {
    expect(sanitizeUserFacingText("Hello</s>")).toBe("Hello");
    expect(sanitizeUserFacingText("Hello <s>world</s>")).toBe("Hello world");
  });

  it("sanitizes role ordering errors with italics", () => {
    const result = sanitizeUserFacingText("400 Incorrect role information");
    expect(result).toContain("*Message ordering conflict");
    expect(result[result.length - 1]).toBe("*");
  });

  it("sanitizes HTTP status errors with error hints and italics", () => {
    expect(sanitizeUserFacingText("500 Internal Server Error")).toBe(
      "*HTTP 500: Internal Server Error*",
    );
  });

  it("sanitizes raw API error payloads with italics", () => {
    const raw = '{"type":"error","error":{"message":"Something exploded","type":"server_error"}}';
    expect(sanitizeUserFacingText(raw)).toBe("*Something exploded*");
  });

  it("sanitizes HTTP 529 overloaded error with italic friendly message", () => {
    const raw =
      'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"},"request_id":"req_011CYeULdpxKGKgj9p4nJkyS"}';
    expect(sanitizeUserFacingText(raw)).toBe(
      "*The AI service is temporarily overloaded. Please try again in a moment.*",
    );
  });

  it("sanitizes auth errors with italic friendly message", () => {
    const raw =
      'Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth token has expired."}}';
    expect(sanitizeUserFacingText(raw)).toBe(
      "*Authentication expired. Please re-authenticate and try again.*",
    );
  });

  // System-error content (EACCES, "permission denied", stack traces,
  // "command line is too long", etc.) MUST pass through the normal-text
  // sanitizer untouched — Claw can legitimately discuss those phrases in
  // a reply. The error-path formatter (formatAssistantErrorText) handles
  // those, since it only runs when the message is already known to be
  // an error.
  it("does not clobber legitimate text that mentions permission denied", () => {
    const text = "If you see `permission denied` in your logs, try sudo or check file ACLs.";
    expect(sanitizeUserFacingText(text)).toBe(text);
  });

  it("does not clobber legitimate text that mentions EACCES", () => {
    const text = "Node reports EACCES when your process lacks permission to open a socket.";
    expect(sanitizeUserFacingText(text)).toBe(text);
  });

  it("does not clobber legitimate text that mentions 'command line is too long'", () => {
    const text =
      "Windows cmd.exe has an 8191-character limit; you'll see 'The command line is too long' if you exceed it.";
    expect(sanitizeUserFacingText(text)).toBe(text);
  });

  it("does not clobber legitimate text containing a Node stack-frame-like pattern", () => {
    const text = "Here's the line that threw: (server.js:42:7) — it's a null deref.";
    expect(sanitizeUserFacingText(text)).toBe(text);
  });

  it("collapses consecutive duplicate paragraphs", () => {
    const text = "Hello there!\n\nHello there!";
    expect(sanitizeUserFacingText(text)).toBe("Hello there!");
  });

  it("does not collapse distinct paragraphs", () => {
    const text = "Hello there!\n\nDifferent line.";
    expect(sanitizeUserFacingText(text)).toBe(text);
  });
});

describe("isRawApiErrorPayload", () => {
  it("detects raw JSON error payloads", () => {
    expect(
      isRawApiErrorPayload(
        '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
      ),
    ).toBe(true);
  });

  it("detects API Error prefixed payloads with status code", () => {
    expect(
      isRawApiErrorPayload(
        'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"},"request_id":"req_abc"}',
      ),
    ).toBe(true);
  });

  it("returns false for normal text", () => {
    expect(isRawApiErrorPayload("Hello world")).toBe(false);
  });
});
