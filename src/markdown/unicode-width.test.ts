import { describe, expect, it } from "vitest";
import { convertMarkdownTables } from "./tables.js";
import { HAIRSPACE, cellVisualWidth, countWideChars, hairspaceCount } from "./unicode-width.js";

describe("cellVisualWidth", () => {
  it("counts ASCII as 1 column each", () => {
    expect(cellVisualWidth("Hello")).toBe(5);
    expect(cellVisualWidth("abc")).toBe(3);
  });

  it("counts CJK as 2 columns each", () => {
    expect(cellVisualWidth("中国")).toBe(4);
    expect(cellVisualWidth("こんにちは")).toBe(10);
  });

  it("counts Hangul as 2 columns each", () => {
    expect(cellVisualWidth("한국")).toBe(4);
    expect(cellVisualWidth("안녕하세요")).toBe(10);
  });

  it("counts emoji as 2 columns each", () => {
    expect(cellVisualWidth("🎉")).toBe(2);
    expect(cellVisualWidth("🎉🎊")).toBe(4);
  });

  it("handles mixed content", () => {
    // "한국 (Korea)" = 2 Hangul (4) + 8 ASCII (8) = 12
    expect(cellVisualWidth("한국 (Korea)")).toBe(12);
    // "中国 (China)" = 2 CJK (4) + 8 ASCII (8) = 12
    expect(cellVisualWidth("中国 (China)")).toBe(12);
  });

  it("skips zero-width characters", () => {
    // ZWJ (U+200D) is zero-width
    expect(cellVisualWidth("a\u200Db")).toBe(2);
    // Variation selector
    expect(cellVisualWidth("a\uFE0Fb")).toBe(2);
  });
});

describe("countWideChars", () => {
  it("counts CJK characters", () => {
    expect(countWideChars("中国")).toEqual({ cjk: 2, hangul: 0, emoji: 0 });
  });

  it("counts Hangul characters", () => {
    expect(countWideChars("한국")).toEqual({ cjk: 0, hangul: 2, emoji: 0 });
  });

  it("counts emoji characters", () => {
    expect(countWideChars("🎉🎊")).toEqual({ cjk: 0, hangul: 0, emoji: 2 });
  });

  it("handles mixed content with ASCII", () => {
    const result = countWideChars("한국 (Korea)");
    expect(result).toEqual({ cjk: 0, hangul: 2, emoji: 0 });
  });
});

describe("hairspaceCount", () => {
  it("returns 0 for ASCII-only text", () => {
    expect(hairspaceCount("Hello")).toBe(0);
  });

  it("uses floor(n * 10/3) for CJK", () => {
    expect(hairspaceCount("中")).toBe(3); // floor(1 * 10/3) = 3
    expect(hairspaceCount("中国")).toBe(6); // floor(2 * 10/3) = 6
    expect(hairspaceCount("こんにちは")).toBe(16); // floor(5 * 10/3) = 16
  });

  it("uses floor(n * 11/2) for Hangul", () => {
    expect(hairspaceCount("한")).toBe(5); // floor(1 * 11/2) = 5
    expect(hairspaceCount("한국")).toBe(11); // floor(2 * 11/2) = 11
    expect(hairspaceCount("안녕하세요")).toBe(27); // floor(5 * 11/2) = 27
  });

  it("uses floor(n * 10/3) for emoji", () => {
    expect(hairspaceCount("🎉")).toBe(3); // floor(1 * 10/3) = 3
    expect(hairspaceCount("🎉🎊🎈")).toBe(10); // floor(3 * 10/3) = 10
  });
});

describe("table hairspacing", () => {
  it("inserts hairspaces for CJK characters in code tables", () => {
    const md = [
      "| Name | Value |",
      "|------|-------|",
      "| 東京 | 14M   |",
      "| NYC  | 8M    |",
    ].join("\n");

    const result = convertMarkdownTables(md, "code", { tableHairspacing: true });
    expect(result).toContain(HAIRSPACE);
    // CJK row should have hairspaces, ASCII row should not
    const lines = result.split("\n");
    const tokyoLine = lines.find((l) => l.includes("東京"));
    const nycLine = lines.find((l) => l.includes("NYC"));
    expect(tokyoLine).toContain(HAIRSPACE);
    expect(nycLine).not.toContain(HAIRSPACE);
  });

  it("does not insert hairspaces when disabled", () => {
    const md = ["| Name | Value |", "|------|-------|", "| 東京 | 14M   |"].join("\n");

    const result = convertMarkdownTables(md, "code", { tableHairspacing: false });
    expect(result).not.toContain(HAIRSPACE);
  });

  it("inserts more hairspaces for Hangul than CJK", () => {
    const md = [
      "| Language | Greeting   |",
      "|----------|-----------|",
      "| Japanese | こんにちは |",
      "| Korean   | 안녕하세요 |",
    ].join("\n");

    const result = convertMarkdownTables(md, "code", { tableHairspacing: true });
    const lines = result.split("\n");
    const jpLine = lines.find((l) => l.includes("こんにちは"))!;
    const krLine = lines.find((l) => l.includes("안녕하세요"))!;

    const countHairspaces = (s: string) => [...s].filter((c) => c === HAIRSPACE).length;
    const jpHs = countHairspaces(jpLine);
    const krHs = countHairspaces(krLine);

    // Hangul ratio (11/2) > CJK ratio (10/3), so Korean gets more
    expect(krHs).toBeGreaterThan(jpHs);
    // 5 CJK: floor(50/3) = 16, 5 Hangul: floor(55/2) = 27
    expect(jpHs).toBe(16);
    expect(krHs).toBe(27);
  });

  it("aligns pipes for mixed ASCII and wide-char rows", () => {
    const md = [
      "| City     | Pop |",
      "|----------|-----|",
      "| New York | 8M  |",
      "| 東京     | 14M |",
    ].join("\n");

    const result = convertMarkdownTables(md, "code", { tableHairspacing: true });
    // Should be a valid code-fenced table
    expect(result).toMatch(/^```\n/);
    expect(result).toMatch(/\n```$/);
  });
});
