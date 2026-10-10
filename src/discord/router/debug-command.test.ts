import { describe, expect, it } from "vitest";
import {
  DEBUG_COMMAND_SPEC,
  DEBUG_SUBCOMMANDS,
  type DebugSubcommand,
  buildDebugHelpEmbeds,
  parseDebugCommand,
  runDebugCommand,
  tokenizeDebugCommand,
} from "./debug-command.js";

describe("tokenizeDebugCommand", () => {
  it("splits on whitespace", () => {
    expect(tokenizeDebugCommand("echo hello world")).toEqual(["echo", "hello", "world"]);
  });

  it("keeps a double-quoted span as one token and strips the quotes", () => {
    expect(tokenizeDebugCommand('echo "hello world"')).toEqual(["echo", "hello world"]);
  });

  it("keeps a single-quoted span as one token", () => {
    expect(tokenizeDebugCommand("echo 'hello world'")).toEqual(["echo", "hello world"]);
  });

  it("collapses runs of whitespace and trims", () => {
    expect(tokenizeDebugCommand("  echo   a\tb  ")).toEqual(["echo", "a", "b"]);
  });

  it("yields an empty-string token for an explicit empty quote", () => {
    expect(tokenizeDebugCommand('echo ""')).toEqual(["echo", ""]);
  });

  it("runs an unterminated quote to the end of the string", () => {
    expect(tokenizeDebugCommand('echo "hello world')).toEqual(["echo", "hello world"]);
  });

  it("returns no tokens for an empty or whitespace-only string", () => {
    expect(tokenizeDebugCommand("")).toEqual([]);
    expect(tokenizeDebugCommand("   ")).toEqual([]);
  });
});

describe("parseDebugCommand", () => {
  it("lowercases the subcommand and keeps args verbatim", () => {
    expect(parseDebugCommand('ECHO "Hello World"')).toEqual({
      subcommand: "echo",
      args: ["Hello World"],
    });
  });

  it("returns a null subcommand for empty input", () => {
    expect(parseDebugCommand("")).toEqual({ subcommand: null, args: [] });
  });
});

describe("runDebugCommand", () => {
  it("prints help when the input is empty", () => {
    const result = runDebugCommand("");
    expect(result.kind).toBe("embeds");
    if (result.kind !== "embeds") {
      throw new Error("expected embeds");
    }
    expect(result.embeds[0].title).toBe("Debug Subcommands");
    expect(result.attachments).toEqual(["debug.png"]);
  });

  it("prints help for the explicit help subcommand", () => {
    const empty = runDebugCommand("");
    const explicit = runDebugCommand("help");
    expect(explicit.kind).toBe("embeds");
    if (empty.kind !== "embeds" || explicit.kind !== "embeds") {
      throw new Error("expected embeds");
    }
    expect(explicit.embeds[0].title).toBe(empty.embeds[0].title);
    expect(explicit.embeds[0].fields).toEqual(empty.embeds[0].fields);
  });

  it("echoes a quoted message as raw content", () => {
    expect(runDebugCommand('echo "hello world"')).toEqual({
      kind: "content",
      content: "hello world",
    });
  });

  it("echoes unquoted text joined by single spaces", () => {
    expect(runDebugCommand("echo hello   world")).toEqual({
      kind: "content",
      content: "hello world",
    });
  });

  it("is case-insensitive on the subcommand name", () => {
    expect(runDebugCommand("ECHO hi")).toEqual({ kind: "content", content: "hi" });
  });

  it("returns a notice embed when echo has no message", () => {
    const result = runDebugCommand("echo");
    expect(result.kind).toBe("embeds");
    if (result.kind !== "embeds") {
      throw new Error("expected embeds");
    }
    expect(result.embeds[0].title).toBe("Nothing to Echo");
  });

  it("returns an unknown-subcommand notice for an unregistered name", () => {
    const result = runDebugCommand("bogus arg");
    expect(result.kind).toBe("embeds");
    if (result.kind !== "embeds") {
      throw new Error("expected embeds");
    }
    expect(result.embeds[0].title).toBe("Unknown Subcommand");
    expect(result.embeds[0].description).toContain("`bogus`");
  });
});

describe("buildDebugHelpEmbeds", () => {
  it("lists subcommands alphabetically in a single embed when they fit", () => {
    const { embeds, attachments } = buildDebugHelpEmbeds(DEBUG_SUBCOMMANDS);
    expect(embeds).toHaveLength(1);
    const embed = embeds[0];
    expect(embed.title).toBe("Debug Subcommands");
    expect(embed.description).toBe(
      "Below are all of the currently-registered subcommands under the `/debug` command...",
    );
    expect(embed.color).toBe(0xff80e0);
    expect(embed.fields).toEqual([
      { name: "`echo <message>`", value: "Sends the raw text as an individual message." },
      { name: "`help`", value: "Prints this help message." },
    ]);
    expect(embed.footer).toEqual({ text: "Debug", icon_url: "attachment://debug.png" });
    expect(embed.timestamp).toBeDefined();
    expect(attachments).toEqual(["debug.png"]);
  });

  it("overflows to multiple embeds, placing title/description first and footer last", () => {
    // Build enough synthetic subcommands to exceed the 25-field-per-embed cap.
    const many: DebugSubcommand[] = Array.from({ length: 60 }, (_unused, index) => {
      const name = `cmd${String(index).padStart(3, "0")}`;
      return {
        name,
        usage: `${name} <arg>`,
        description: `Description for ${name}.`,
        run: () => ({ kind: "content", content: "" }),
      };
    });
    const { embeds } = buildDebugHelpEmbeds(many);
    expect(embeds.length).toBeGreaterThan(1);

    // First embed carries the title and description; the rest do not.
    expect(embeds[0].title).toBe("Debug Subcommands");
    expect(embeds[0].description).toBeDefined();
    for (const embed of embeds.slice(1)) {
      expect(embed.title).toBeUndefined();
      expect(embed.description).toBeUndefined();
    }

    // Only the last embed carries the footer and timestamp.
    const last = embeds.length - 1;
    embeds.forEach((embed, index) => {
      if (index === last) {
        expect(embed.footer).toEqual({ text: "Debug", icon_url: "attachment://debug.png" });
        expect(embed.timestamp).toBeDefined();
      } else {
        expect(embed.footer).toBeUndefined();
        expect(embed.timestamp).toBeUndefined();
      }
      // Every embed shares the category color and respects the field cap.
      expect(embed.color).toBe(0xff80e0);
      expect((embed.fields ?? []).length).toBeLessThanOrEqual(25);
      const chars =
        (embed.title?.length ?? 0) +
        (embed.description?.length ?? 0) +
        (embed.footer?.text.length ?? 0) +
        (embed.fields ?? []).reduce((sum, f) => sum + f.name.length + f.value.length, 0);
      expect(chars).toBeLessThanOrEqual(6000);
    });

    // No field is lost or duplicated across the overflow.
    const total = embeds.reduce((sum, embed) => sum + (embed.fields ?? []).length, 0);
    expect(total).toBe(many.length);
  });

  it("sorts fields alphabetically regardless of input order", () => {
    const subs: DebugSubcommand[] = [
      {
        name: "zed",
        usage: "zed",
        description: "z",
        run: () => ({ kind: "content", content: "" }),
      },
      {
        name: "alpha",
        usage: "alpha",
        description: "a",
        run: () => ({ kind: "content", content: "" }),
      },
    ];
    const { embeds } = buildDebugHelpEmbeds(subs);
    expect((embeds[0].fields ?? []).map((f) => f.name)).toEqual(["`alpha`", "`zed`"]);
  });
});

describe("DEBUG_COMMAND_SPEC", () => {
  it("declares a single optional free-text command option", () => {
    expect(DEBUG_COMMAND_SPEC.name).toBe("debug");
    expect(DEBUG_COMMAND_SPEC.options).toHaveLength(1);
    const option = DEBUG_COMMAND_SPEC.options[0];
    expect(option.name).toBe("command");
    expect(option.required).toBe(false);
    expect(option.type).toBe(3);
  });
});
