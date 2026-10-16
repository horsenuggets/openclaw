import { describe, expect, it } from "vitest";
import { MAX_FIELD_NAME_CHARS, MAX_FIELD_VALUE_CHARS } from "./embed-limits.js";
import {
  buildSubcommandFields,
  buildSubcommandHelpEmbeds,
  subcommandHelpDescription,
} from "./subcommand-fields.js";

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

describe("subcommandHelpDescription", () => {
  it("renders the shared help sentence parameterized by command name", () => {
    expect(subcommandHelpDescription("/debug")).toBe(
      "Below are all of the currently-registered subcommands under the `/debug` command...",
    );
    expect(subcommandHelpDescription("/connections")).toBe(
      "Below are all of the currently-registered subcommands under the `/connections` command...",
    );
  });
});

describe("buildSubcommandHelpEmbeds", () => {
  it("builds a single help embed with the title, shared description, and one field per entry", () => {
    const { embeds, attachments } = buildSubcommandHelpEmbeds({
      category: "connections",
      title: "Connections Subcommands",
      command: "/connections",
      entries: [
        { usage: "add <service>", description: "Connect a new service." },
        { usage: "list", description: "List your currently-linked accounts." },
      ],
    });
    expect(embeds).toHaveLength(1);
    const embed = embeds[0];
    expect(embed.title).toBe("Connections Subcommands");
    expect(embed.description).toBe(subcommandHelpDescription("/connections"));
    expect(embed.fields).toEqual([
      { name: "`/connections add <service>`", value: "Connect a new service." },
      { name: "`/connections list`", value: "List your currently-linked accounts." },
    ]);
    expect(embed.footer).toBeDefined();
    expect(attachments).toHaveLength(1);
  });

  it("preserves entry order (the caller sorts if it wants to)", () => {
    const { embeds } = buildSubcommandHelpEmbeds({
      category: "debug",
      title: "Debug Subcommands",
      command: "/debug",
      entries: [
        { usage: "zeta", description: "last" },
        { usage: "alpha", description: "first" },
      ],
    });
    expect((embeds[0].fields ?? []).map((f) => f.name)).toEqual([
      "`/debug zeta`",
      "`/debug alpha`",
    ]);
  });
});
