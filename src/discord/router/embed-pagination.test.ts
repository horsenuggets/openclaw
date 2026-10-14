import { describe, expect, it } from "vitest";
import { EMBED_CATEGORIES } from "./embed-categories.js";
import { buildPaginatedEmbeds, chunkLinesIntoFields } from "./embed-pagination.js";

const CAT = EMBED_CATEGORIES.connections;
const field = (name: string, value: string) => ({ name, value });

describe("buildPaginatedEmbeds", () => {
  it("puts title/description on the first embed and footer/icon on the last", () => {
    const { embeds, attachments } = buildPaginatedEmbeds({
      category: "connections",
      title: "Title",
      description: "Desc",
      groups: [[field("a", "1"), field("b", "2")]],
    });
    expect(embeds).toHaveLength(1);
    expect(embeds[0].title).toBe("Title");
    expect(embeds[0].description).toBe("Desc");
    expect(embeds[0].color).toBe(CAT.color);
    expect(embeds[0].footer).toEqual({
      text: CAT.footerText,
      icon_url: `attachment://${CAT.icon}`,
    });
    expect(attachments).toEqual([CAT.icon]);
  });

  it("forces each group after the first onto a new embed", () => {
    const { embeds } = buildPaginatedEmbeds({
      category: "connections",
      title: "T",
      description: "D",
      groups: [[field("header", "h")], [field("body", "b")]],
    });
    expect(embeds).toHaveLength(2);
    // Header group on embed 0 (with title), body group on embed 1 (with footer).
    expect(embeds[0].title).toBe("T");
    expect(embeds[0].footer).toBeUndefined();
    expect((embeds[0].fields ?? []).map((f) => f.name)).toEqual(["header"]);
    expect(embeds[1].title).toBeUndefined();
    expect((embeds[1].fields ?? []).map((f) => f.name)).toEqual(["body"]);
    expect(embeds[1].footer?.text).toBe(CAT.footerText);
  });

  it("overflows a single group past the 25-field cap into more embeds", () => {
    const many = Array.from({ length: 60 }, (_, i) => field(`f${i}`, "x"));
    const { embeds } = buildPaginatedEmbeds({
      category: "connections",
      title: "T",
      description: "D",
      groups: [many],
    });
    expect(embeds.length).toBeGreaterThan(1);
    for (const embed of embeds) {
      expect((embed.fields ?? []).length).toBeLessThanOrEqual(25);
    }
  });

  it("appends the truncation field when the message budget is exhausted", () => {
    const big = Array.from({ length: 400 }, (_, i) => field(`field-${i}`, "y".repeat(120)));
    const { embeds } = buildPaginatedEmbeds({
      category: "connections",
      title: "T",
      description: "D",
      groups: [big],
      truncationField: { name: "...", value: "omitted-some" },
    });
    expect(embeds.length).toBeLessThanOrEqual(10);
    const rendered = embeds.reduce((n, e) => n + (e.fields ?? []).length, 0);
    expect(rendered).toBeLessThan(big.length);
    const lastField = (embeds.at(-1)?.fields ?? []).at(-1);
    expect(lastField?.value).toBe("omitted-some");
  });

  it("does not truncate when the full payload fits even though a note would not", () => {
    // Footer is ~small; build fields whose total (with title/description/footer) lands
    // just under 6000. A naive up-front note reserve would wrongly drop the last field.
    const footerLen = CAT.footerText.length;
    const base = "T".length + "D".length + footerLen;
    // Fill to within a hair of 6000 using several large fields, each name "f".
    const room = 6000 - base;
    // 5 fields of ~equal size that sum to exactly `room` (name length 1 each counts too).
    const perField = Math.floor(room / 5);
    // cost = name(1) + value length; keep each <= 1024 so no per-field clamp fires.
    const valueLen = Math.min(perField - 1, 1024);
    const fields = Array.from({ length: 5 }, () => field("f", "x".repeat(valueLen)));
    const { embeds } = buildPaginatedEmbeds({
      category: "connections",
      title: "T",
      description: "D",
      groups: [fields],
    });
    const rendered = embeds.flatMap((e) => e.fields ?? []);
    // Every supplied field is present and no truncation note was added.
    expect(rendered).toHaveLength(5);
    expect(rendered.some((f) => f.name === "\u2026")).toBe(false);
    const total = embeds.reduce(
      (n, e) =>
        n +
        (e.title?.length ?? 0) +
        (e.description?.length ?? 0) +
        (e.footer?.text.length ?? 0) +
        (e.fields ?? []).reduce((m, f) => m + f.name.length + f.value.length, 0),
      0,
    );
    expect(total).toBeLessThanOrEqual(6000);
  });

  it("clamps an over-long caller truncation field so it never breaches the caps", () => {
    const big = Array.from({ length: 400 }, (_, i) => field(`field-${i}`, "y".repeat(120)));
    const { embeds } = buildPaginatedEmbeds({
      category: "connections",
      title: "T",
      description: "D",
      groups: [big],
      // A pathological caller note far larger than the 1024 field cap and 6000 budget.
      truncationField: { name: "note", value: "z".repeat(5000) },
    });
    const appended = (embeds.at(-1)?.fields ?? []).at(-1);
    expect(appended?.value.length).toBeLessThanOrEqual(1024);
    expect(appended?.value.endsWith("\u2026")).toBe(true);
    // The whole message (clamped note included) stays within Discord's 6000 budget.
    const total = embeds.reduce(
      (n, e) =>
        n +
        (e.title?.length ?? 0) +
        (e.description?.length ?? 0) +
        (e.footer?.text.length ?? 0) +
        (e.fields ?? []).reduce((m, f) => m + f.name.length + f.value.length, 0),
      0,
    );
    expect(total).toBeLessThanOrEqual(6000);
  });

  it("clamps an over-long title and description to their per-embed caps", () => {
    const { embeds } = buildPaginatedEmbeds({
      category: "connections",
      title: "t".repeat(400),
      description: "d".repeat(5000),
      groups: [[field("a", "1")]],
    });
    expect((embeds[0].title ?? "").length).toBeLessThanOrEqual(256);
    expect((embeds[0].description ?? "").length).toBeLessThanOrEqual(4096);
    expect(embeds[0].title?.endsWith("\u2026")).toBe(true);
    expect(embeds[0].description?.endsWith("\u2026")).toBe(true);
  });

  it("clamps an over-long group field value to the per-field cap", () => {
    const { embeds } = buildPaginatedEmbeds({
      category: "connections",
      title: "T",
      description: "D",
      groups: [[field("big", "q".repeat(3000))]],
    });
    const only = (embeds[0].fields ?? [])[0];
    expect(only.value.length).toBeLessThanOrEqual(1024);
    expect(only.value.endsWith("\u2026")).toBe(true);
  });

  it("skips empty groups without emitting a blank embed", () => {
    const { embeds } = buildPaginatedEmbeds({
      category: "connections",
      title: "T",
      description: "D",
      groups: [[], [field("only", "x")]],
    });
    expect(embeds).toHaveLength(1);
    expect((embeds[0].fields ?? []).map((f) => f.name)).toEqual(["only"]);
  });
});

describe("chunkLinesIntoFields", () => {
  it("keeps all lines in one field when they fit", () => {
    const fields = chunkLinesIntoFields("Services", ["a", "b", "c"]);
    expect(fields).toEqual([{ name: "Services", value: "a\nb\nc" }]);
  });

  it("splits into multiple same-named fields under the max", () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line-${i}`.repeat(10));
    const fields = chunkLinesIntoFields("Services", lines, 100);
    expect(fields.length).toBeGreaterThan(1);
    for (const f of fields) {
      expect(f.name).toBe("Services");
      expect(f.value.length).toBeLessThanOrEqual(100);
      expect(f.value.length).toBeGreaterThan(0);
    }
    // Every line is preserved, in order.
    expect(
      fields
        .map((f) => f.value)
        .join("\n")
        .split("\n"),
    ).toEqual(lines);
  });

  it("truncates an over-long single line to fit the max rather than dropping it", () => {
    const long = "z".repeat(50);
    const fields = chunkLinesIntoFields("Services", ["short", long], 20);
    expect(fields).toHaveLength(2);
    expect(fields[0].value).toBe("short");
    // The over-long line is clamped to the cap with an ellipsis, never exceeding max.
    expect(fields[1].value.length).toBeLessThanOrEqual(20);
    expect(fields[1].value.endsWith("\u2026")).toBe(true);
    expect(fields[1].value.startsWith("z")).toBe(true);
  });
});
