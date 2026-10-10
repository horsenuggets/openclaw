import { describe, expect, it } from "vitest";
import type { DiscordEmbed } from "./channel-commands.js";
import {
  DEBUG_COMMAND_SPEC,
  DEBUG_SUBCOMMANDS,
  type DebugSubcommand,
  buildDebugHelpEmbeds,
  debugSubcommandLabel,
  parseDebugCommand,
  runDebugCommand,
  tokenizeDebugCommand,
} from "./debug-command.js";

/** Discord counts this combined text against the shared 6000-char message cap. */
function messageChars(embeds: DiscordEmbed[]): number {
  return embeds.reduce(
    (sum, embed) =>
      sum +
      (embed.title?.length ?? 0) +
      (embed.description?.length ?? 0) +
      (embed.footer?.text.length ?? 0) +
      (embed.fields ?? []).reduce((acc, f) => acc + f.name.length + f.value.length, 0),
    0,
  );
}

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

    // At most 10 embeds per message (Discord's hard cap).
    expect(embeds.length).toBeLessThanOrEqual(10);

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
    });

    // The message-wide character budget (6000, shared across all embeds) holds.
    expect(messageChars(embeds)).toBeLessThanOrEqual(6000);

    // These 60 fields fit comfortably, so none are dropped.
    const total = embeds.reduce((sum, embed) => sum + (embed.fields ?? []).length, 0);
    expect(total).toBe(many.length);
  });

  it("truncates with a note when the registry exceeds the message-wide budget", () => {
    // Each field here costs ~120 chars, so a few hundred blow past 6000.
    const huge: DebugSubcommand[] = Array.from({ length: 400 }, (_unused, index) => {
      const name = `command-number-${String(index).padStart(4, "0")}`;
      return {
        name,
        usage: `${name} <argument>`,
        description: `A fairly long description for ${name} so the message budget is exhausted fast.`,
        run: () => ({ kind: "content", content: "" }),
      };
    });
    const { embeds } = buildDebugHelpEmbeds(huge);

    expect(embeds.length).toBeLessThanOrEqual(10);
    expect(messageChars(embeds)).toBeLessThanOrEqual(6000);
    for (const embed of embeds) {
      expect((embed.fields ?? []).length).toBeLessThanOrEqual(25);
    }

    // Fewer fields than subcommands were rendered, and the final field is the note.
    const rendered = embeds.reduce((sum, embed) => sum + (embed.fields ?? []).length, 0);
    expect(rendered).toBeLessThan(huge.length);
    const lastEmbedFields = embeds[embeds.length - 1].fields ?? [];
    expect(lastEmbedFields.at(-1)?.value).toContain("omitted");
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

describe("debugSubcommandLabel", () => {
  it("labels empty input as help", () => {
    expect(debugSubcommandLabel("")).toBe("(help)");
  });

  it("returns the name only for a registered subcommand", () => {
    expect(debugSubcommandLabel("echo hi")).toBe("echo");
    expect(debugSubcommandLabel("HELP")).toBe("help");
  });

  it("never echoes unrecognized input (e.g. a pasted credential)", () => {
    expect(debugSubcommandLabel("sk-secret-token-value")).toBe("(unknown)");
    expect(debugSubcommandLabel("bogus whatever")).toBe("(unknown)");
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
