import { describe, expect, it } from "vitest";
import { CONNFLOW_SCENARIOS, getConnFlowScenario, simulateConnFlow } from "./connflow-preview.js";
import { EMBED_CATEGORIES } from "./embed-categories.js";

const DEBUG = EMBED_CATEGORIES.debug;
const EMOJI = {
  connected: "<:greencheckfilled:1>",
  connecting: "<:bluecheckempty:2>",
  notConnected: "<:redxfilled:3>",
  needsAuth: "<:warningsquare:4>",
};

function run(scenarioId: number, tokens: string[]) {
  const scenario = getConnFlowScenario(scenarioId);
  if (!scenario) {
    throw new Error(`no scenario ${scenarioId}`);
  }
  return simulateConnFlow({ scenario, tokens, emoji: EMOJI });
}

/** Concatenate a named column across every embed. */
function column(embeds: { fields?: { name: string; value: string }[] }[], name: string) {
  return embeds
    .flatMap((e) => e.fields ?? [])
    .filter((f) => f.name === name)
    .map((f) => f.value)
    .join("\n");
}

describe("getConnFlowScenario", () => {
  it("resolves known ids and rejects unknown ones", () => {
    expect(getConnFlowScenario(1)?.label).toBe("No connections");
    expect(getConnFlowScenario(99)).toBeNull();
  });
});

describe("simulateConnFlow re-skinning", () => {
  it("recolors every embed to Debug and rewrites footers to the debug icon", async () => {
    const out = await run(3, ["list"]);
    expect(out.attachments).toEqual([DEBUG.icon]);
    expect(out.embeds.length).toBeGreaterThan(0);
    for (const embed of out.embeds) {
      expect(embed.color).toBe(DEBUG.color);
    }
    const footered = out.embeds.filter((e) => e.footer);
    expect(footered.length).toBeGreaterThan(0);
    for (const embed of footered) {
      expect(embed.footer?.text).toBe(DEBUG.footerText);
      expect(embed.footer?.icon_url).toBe(`attachment://${DEBUG.icon}`);
    }
  });
});

describe("simulateConnFlow scenarios", () => {
  it("scenario 1 list shows the empty note plus the subcommands in one embed", async () => {
    const out = await run(1, ["list"]);
    expect(out.embeds).toHaveLength(1);
    expect(out.embeds[0].title).toBe("Your Connections");
    expect(out.embeds[0].description).toContain("not linked any accounts yet");
    const names = (out.embeds[0].fields ?? []).map((f) => f.name);
    expect(names).toContain("`/conn add <service>`");
    expect(names).not.toContain("Services");
  });

  it("scenario 2 list renders mixed statuses as glyph-led service lines", async () => {
    const out = await run(2, ["list"]);
    const services = column(out.embeds, "Services");
    expect(services).toContain("<:greencheckfilled:1> Todoist");
    expect(services).toContain("<:warningsquare:4> Notion");
    expect(services).toContain("<:bluecheckempty:2> GitHub");
    const legend = column(out.embeds, "Legend");
    expect(legend).toContain('"Connected!" \u2192 <:greencheckfilled:1>');
  });

  it("scenario 3 list reports every linkable service connected", async () => {
    const out = await run(3, ["list"]);
    const count = out.embeds
      .flatMap((e) => e.fields ?? [])
      .find((f) => f.name === "Currently Connected");
    expect(count?.value).toBe("`3/3`");
  });

  it("add without a token shows the service's setup instructions", async () => {
    const out = await run(1, ["add", "notion"]);
    expect(out.embeds[0].title).toBe("Link Notion");
    expect(out.embeds[0].description).toContain("/connections add notion <token>");
    // Debug identity, not Connections.
    expect(out.embeds[0].color).toBe(DEBUG.color);
    expect(out.embeds[0].footer?.text).toBe(DEBUG.footerText);
  });

  it("add with a token previews the success path with no real network call", async () => {
    const out = await run(1, ["add", "notion", "fake-token"]);
    expect(out.embeds[0].title).toBe("Connected!");
    expect(out.embeds[0].description).toContain("is now linked");
  });
});

describe("CONNFLOW_SCENARIOS", () => {
  it("has stable, unique, authorized scenarios", () => {
    const ids = CONNFLOW_SCENARIOS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([1, 2, 3]);
  });
});
