import { describe, expect, it } from "vitest";
import { connectorRegistry } from "./connectors.js";

describe("connectorRegistry.get", () => {
  it("resolves ids case-insensitively", () => {
    expect(connectorRegistry.get("todoist")?.label).toBe("Todoist");
    expect(connectorRegistry.get("TODOIST")?.label).toBe("Todoist");
    expect(connectorRegistry.get("  GitHub ")?.id).toBe("github");
  });

  it("returns null for unknown or empty ids", () => {
    expect(connectorRegistry.get("slack")).toBeNull();
    expect(connectorRegistry.get("")).toBeNull();
    expect(connectorRegistry.get(undefined)).toBeNull();
  });
});

describe("connector catalog", () => {
  it("lists only wired services as available", () => {
    expect(connectorRegistry.availableIds()).toBe("todoist, notion, github");
  });

  it("marks Google as catalogued but not yet available", () => {
    const google = connectorRegistry.get("google");
    expect(google?.available).toBe(false);
    expect(google?.auth.kind).toBe("cli");
  });

  it("gives every paste-token connector a token howto and url", () => {
    for (const c of connectorRegistry.all()) {
      if (c.auth.kind === "paste-token") {
        expect(c.available).toBe(true);
        const prompt = c.auth.begin();
        expect(prompt.howto, `${c.id} howto`).toBeTruthy();
        expect(prompt.url, `${c.id} url`).toMatch(/^https:\/\//);
        expect(c.services.length).toBeGreaterThan(0);
      }
    }
  });

  it("points Todoist at its developer settings page", () => {
    expect(connectorRegistry.get("todoist")?.auth.begin().url).toBe(
      "https://app.todoist.com/app/settings/integrations/developer",
    );
  });

  it("leads with the two short-term priorities", () => {
    expect(
      connectorRegistry
        .all()
        .slice(0, 2)
        .map((c) => c.id),
    ).toEqual(["google", "todoist"]);
  });
});
