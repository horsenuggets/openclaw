import { describe, expect, it } from "vitest";
import { MAX_FIELD_NAME_CHARS, MAX_FIELD_VALUE_CHARS } from "./embed-limits.js";
import { buildSubcommandFields } from "./subcommand-fields.js";

describe("buildSubcommandFields", () => {
  it("formats the name as backtick-wrapped `<prefix> <usage>` and the value as the description", () => {
    const fields = buildSubcommandFields("/conn", [
      { usage: "add <service>", description: "Connect a new service." },
    ]);
    expect(fields).toEqual([{ name: "`/conn add <service>`", value: "Connect a new service." }]);
  });

  it("preserves input order (the caller is responsible for sorting)", () => {
    const fields = buildSubcommandFields("/debug", [
      { usage: "zeta", description: "last" },
      { usage: "alpha", description: "first" },
    ]);
    expect(fields.map((f) => f.name)).toEqual(["`/debug zeta`", "`/debug alpha`"]);
  });

  it("clamps an over-long name to the field-name cap with a trailing ellipsis", () => {
    const usage = "x".repeat(MAX_FIELD_NAME_CHARS);
    const [field] = buildSubcommandFields("/debug", [{ usage, description: "d" }]);
    expect(field.name.length).toBe(MAX_FIELD_NAME_CHARS);
    expect(field.name.endsWith("\u2026")).toBe(true);
  });

  it("clamps an over-long description to the field-value cap with a trailing ellipsis", () => {
    const description = "y".repeat(MAX_FIELD_VALUE_CHARS + 50);
    const [field] = buildSubcommandFields("/debug", [{ usage: "u", description }]);
    expect(field.value.length).toBe(MAX_FIELD_VALUE_CHARS);
    expect(field.value.endsWith("\u2026")).toBe(true);
  });

  it("leaves a name/value that exactly fits unclamped", () => {
    const description = "z".repeat(MAX_FIELD_VALUE_CHARS);
    const [field] = buildSubcommandFields("/debug", [{ usage: "u", description }]);
    expect(field.value).toBe(description);
    expect(field.value.endsWith("\u2026")).toBe(false);
  });

  it("returns an empty array for an empty list", () => {
    expect(buildSubcommandFields("/debug", [])).toEqual([]);
  });
});
