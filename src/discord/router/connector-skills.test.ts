import { describe, expect, it } from "vitest";
import type { StoredConnection } from "./connections-store.js";
import { PasteTokenAuth } from "./connector-auth.js";
import { enabledSkillKeys, skillsEnabledByConnection } from "./connector-skills.js";
import { ConnectorRegistry, connectorRegistry } from "./connectors.js";

function connection(connectorId: string, status: StoredConnection["status"]): StoredConnection {
  return { connectorId, status, linkedAt: "2026-10-13T00:00:00.000Z" };
}

/** A connector whose single credential enables several skills, for the one -> many case. */
function multiSkillRegistry(): ConnectorRegistry {
  return new ConnectorRegistry([
    {
      id: "google",
      label: "Google",
      summary: "Workspace.",
      services: ["Gmail", "Drive"],
      skills: ["gmail", "gdrive", "gdocs"],
      available: true,
      auth: new PasteTokenAuth({
        url: "https://example.com",
        howto: "paste",
        validate: async () => ({ ok: true }),
      }),
    },
  ]);
}

describe("skillsEnabledByConnection", () => {
  it("enables the connector's skills for a linked connection", () => {
    expect(skillsEnabledByConnection(connection("todoist", "linked"), connectorRegistry)).toEqual([
      "todoist",
    ]);
  });

  it("enables nothing for a non-linked connection", () => {
    expect(
      skillsEnabledByConnection(connection("todoist", "needs_reauth"), connectorRegistry),
    ).toEqual([]);
    expect(
      skillsEnabledByConnection(connection("todoist", "not_linked"), connectorRegistry),
    ).toEqual([]);
  });

  it("enables nothing when the connector is no longer in the catalog", () => {
    expect(skillsEnabledByConnection(connection("slack", "linked"), connectorRegistry)).toEqual([]);
  });

  it("enables every skill of a one-connector-many-skills link from one credential", () => {
    expect(skillsEnabledByConnection(connection("google", "linked"), multiSkillRegistry())).toEqual(
      ["gmail", "gdrive", "gdocs"],
    );
  });
});

describe("enabledSkillKeys", () => {
  it("unions the skills of every linked connection in first-seen order", () => {
    const connections = [
      connection("todoist", "linked"),
      connection("notion", "needs_reauth"),
      connection("github", "linked"),
    ];
    expect(enabledSkillKeys(connections, connectorRegistry)).toEqual(["todoist", "github"]);
  });

  it("dedupes skills shared across connectors", () => {
    const registry = new ConnectorRegistry([
      {
        id: "a",
        label: "A",
        summary: "",
        services: ["x"],
        skills: ["shared", "only-a"],
        available: true,
        auth: new PasteTokenAuth({
          url: "https://a",
          howto: "",
          validate: async () => ({ ok: true }),
        }),
      },
      {
        id: "b",
        label: "B",
        summary: "",
        services: ["y"],
        skills: ["shared", "only-b"],
        available: true,
        auth: new PasteTokenAuth({
          url: "https://b",
          howto: "",
          validate: async () => ({ ok: true }),
        }),
      },
    ]);
    const result = enabledSkillKeys(
      [connection("a", "linked"), connection("b", "linked")],
      registry,
    );
    expect(result).toEqual(["shared", "only-a", "only-b"]);
  });

  it("is empty when no connection is linked", () => {
    expect(
      enabledSkillKeys(
        [connection("todoist", "not_linked"), connection("github", "needs_reauth")],
        connectorRegistry,
      ),
    ).toEqual([]);
  });
});
