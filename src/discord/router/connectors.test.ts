import { describe, expect, it } from "vitest";
import { CONNECTORS, availableConnectorIds, getConnector } from "./connectors.js";

describe("getConnector", () => {
  it("resolves ids case-insensitively", () => {
    expect(getConnector("todoist")?.label).toBe("Todoist");
    expect(getConnector("TODOIST")?.label).toBe("Todoist");
    expect(getConnector("  GitHub ")?.id).toBe("github");
  });

  it("returns null for unknown or empty ids", () => {
    expect(getConnector("slack")).toBeNull();
    expect(getConnector("")).toBeNull();
    expect(getConnector(undefined)).toBeNull();
  });
});

describe("connector catalog", () => {
  it("lists only wired services as available", () => {
    expect(availableConnectorIds()).toBe("todoist, notion, github");
  });

  it("marks Google as catalogued but not yet available", () => {
    const google = getConnector("google");
    expect(google?.available).toBe(false);
    expect(google?.authKind).toBe("cli");
  });

  it("gives every paste-token connector a token howto and url", () => {
    for (const c of CONNECTORS) {
      if (c.authKind === "paste-token") {
        expect(c.available).toBe(true);
        expect(c.tokenHowto, `${c.id} howto`).toBeTruthy();
        expect(c.tokenUrl, `${c.id} url`).toMatch(/^https:\/\//);
        expect(c.services.length).toBeGreaterThan(0);
      }
    }
  });

  it("leads with the two short-term priorities", () => {
    expect(CONNECTORS.slice(0, 2).map((c) => c.id)).toEqual(["google", "todoist"]);
  });
});
