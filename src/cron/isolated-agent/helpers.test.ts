import { describe, expect, it } from "vitest";
import { SILENT_REPLY_TOKEN } from "../../auto-reply/tokens.js";
import { isHeartbeatOnlyResponse, sanitizeHeartbeatDeliveryPayloads } from "./helpers.js";

describe("sanitizeHeartbeatDeliveryPayloads", () => {
  it("drops text-only payloads whose text carries the silent token (edge or mid-text)", () => {
    expect(sanitizeHeartbeatDeliveryPayloads([{ text: SILENT_REPLY_TOKEN }])).toEqual([]);
    expect(
      sanitizeHeartbeatDeliveryPayloads([
        { text: `Checked tasks; ${SILENT_REPLY_TOKEN} because all clear` },
      ]),
    ).toEqual([]);
  });

  it("clears token-bearing text but keeps the payload when it has media", () => {
    expect(
      sanitizeHeartbeatDeliveryPayloads([
        { text: `caption ${SILENT_REPLY_TOKEN}`, mediaUrl: "https://example.com/img.png" },
      ]),
    ).toEqual([{ text: undefined, mediaUrl: "https://example.com/img.png" }]);
  });

  it("keeps a real sibling while removing a token-bearing sibling", () => {
    expect(
      sanitizeHeartbeatDeliveryPayloads([
        { text: "Disk almost full" },
        { text: `noted ${SILENT_REPLY_TOKEN}` },
      ]),
    ).toEqual([{ text: "Disk almost full" }]);
  });

  it("passes real replies through untouched", () => {
    const payloads = [{ text: "Disk almost full" }];
    expect(sanitizeHeartbeatDeliveryPayloads(payloads)).toEqual(payloads);
  });
});

describe("isHeartbeatOnlyResponse", () => {
  it("is true for empty, empty-text, and token-only responses", () => {
    expect(isHeartbeatOnlyResponse([])).toBe(true);
    expect(isHeartbeatOnlyResponse([{ text: "   " }])).toBe(true);
    expect(isHeartbeatOnlyResponse([{ text: SILENT_REPLY_TOKEN }])).toBe(true);
  });

  it("is false when any payload has deliverable text or media", () => {
    expect(isHeartbeatOnlyResponse([{ text: "Disk almost full" }])).toBe(false);
    expect(
      isHeartbeatOnlyResponse([{ text: SILENT_REPLY_TOKEN, mediaUrl: "https://e.com/i.png" }]),
    ).toBe(false);
    expect(isHeartbeatOnlyResponse([{ text: SILENT_REPLY_TOKEN }, { text: "real alert" }])).toBe(
      false,
    );
  });
});
