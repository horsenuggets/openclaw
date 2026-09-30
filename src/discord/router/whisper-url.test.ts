import { describe, expect, it } from "vitest";
import { DEFAULT_WHISPER_PORT } from "../../config/port-defaults.js";
import { resolveWhisperUrl } from "./whisper-url.js";

describe("resolveWhisperUrl", () => {
  it("defaults to the shared whisper port on loopback", () => {
    expect(resolveWhisperUrl({})).toBe(`http://127.0.0.1:${DEFAULT_WHISPER_PORT}/inference`);
  });

  it("does not default to the historical 8787 port", () => {
    expect(resolveWhisperUrl({})).not.toContain("8787");
  });

  it("uses OPENCLAW_WHISPER_URL verbatim when set", () => {
    expect(resolveWhisperUrl({ OPENCLAW_WHISPER_URL: "http://whisper.internal/xcribe" })).toBe(
      "http://whisper.internal/xcribe",
    );
  });

  it("prefers the full URL over the port override", () => {
    expect(
      resolveWhisperUrl({
        OPENCLAW_WHISPER_URL: "http://whisper.internal/xcribe",
        OPENCLAW_WHISPER_PORT: "9999",
      }),
    ).toBe("http://whisper.internal/xcribe");
  });

  it("builds a loopback URL from OPENCLAW_WHISPER_PORT", () => {
    expect(resolveWhisperUrl({ OPENCLAW_WHISPER_PORT: "9001" })).toBe(
      "http://127.0.0.1:9001/inference",
    );
  });

  it("trims surrounding whitespace on the overrides", () => {
    expect(resolveWhisperUrl({ OPENCLAW_WHISPER_PORT: "  9001  " })).toBe(
      "http://127.0.0.1:9001/inference",
    );
    expect(resolveWhisperUrl({ OPENCLAW_WHISPER_URL: "  http://x/y  " })).toBe("http://x/y");
  });

  it("falls back to the default for non-numeric or out-of-range ports", () => {
    for (const bad of ["", "abc", "0", "-5", "70000", "80.5"]) {
      expect(resolveWhisperUrl({ OPENCLAW_WHISPER_PORT: bad })).toBe(
        `http://127.0.0.1:${DEFAULT_WHISPER_PORT}/inference`,
      );
    }
  });
});
