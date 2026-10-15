import { afterEach, describe, expect, it, vi } from "vitest";
import { DirectAuth } from "./auth-flow.js";
import { type Connector, ConnectorRegistry, connectorRegistry } from "./connectors.js";

function connector(id: string, skills: string[]): Connector {
  return {
    id,
    label: id,
    summary: "",
    services: ["x"],
    skills,
    available: true,
    auth: new DirectAuth({
      url: `https://${id}`,
      howto: "",
      validate: async () => ({ ok: true }),
    }),
  };
}

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
  it("marks every direct connector as available (connect flow wired)", () => {
    expect(connectorRegistry.available().map((c) => c.id)).toEqual(["todoist", "notion", "github"]);
  });

  it("gives Google an OAuth flow but keeps its connect flow unwired until configured", () => {
    const google = connectorRegistry.get("google");
    expect(google?.available).toBe(false);
    expect(google?.auth.authKind).toBe("oauth");
    expect(google?.auth.outgoing).toBe("link");
    expect(google?.auth.delivery).toBe("paste");
  });
});

describe("Google OAuth configuration", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("builds the Google authorize URL with the expected endpoints, scopes, and PKCE", () => {
    vi.stubEnv("OPENCLAW_GOOGLE_CLIENT_ID", "test-client.apps.googleusercontent.com");
    const prompt = connectorRegistry.get("google")?.auth.begin();
    expect(prompt?.pending).toBeTruthy();
    const url = new URL(prompt?.url ?? "");
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("client_id")).toBe("test-client.apps.googleusercontent.com");
    expect(url.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:8765");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBeTruthy();
    expect(url.searchParams.get("state")).toBeTruthy();
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    const scope = url.searchParams.get("scope") ?? "";
    expect(scope).toContain("openid");
    expect(scope).toContain("email");
    expect(scope).toContain("https://www.googleapis.com/auth/gmail.modify");
    expect(scope).toContain("https://www.googleapis.com/auth/calendar");
  });

  it("refuses to mint an authorize link when the client id is not configured", () => {
    vi.stubEnv("OPENCLAW_GOOGLE_CLIENT_ID", "");
    const prompt = connectorRegistry.get("google")?.auth.begin();
    expect(prompt?.url).toBeUndefined();
    expect(prompt?.pending).toBeUndefined();
  });

  it("gives every direct connector a token howto and url, and sane descriptors", () => {
    for (const c of connectorRegistry.all()) {
      if (c.auth.authKind === "direct") {
        expect(c.available).toBe(true);
        expect(c.auth.outgoing).toBe("instructions");
        expect(c.auth.delivery).toBe("paste");
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

  it("gives every connector at least one skill to enable", () => {
    for (const c of connectorRegistry.all()) {
      expect(c.skills.length, `${c.id} skills`).toBeGreaterThan(0);
    }
  });
});

describe("connectorRegistry.forSkill", () => {
  it("resolves a skill key back to its connector (case-insensitive)", () => {
    expect(connectorRegistry.forSkill("todoist")?.id).toBe("todoist");
    expect(connectorRegistry.forSkill("GOG")?.id).toBe("google");
    expect(connectorRegistry.forSkill("  github ")?.id).toBe("github");
  });

  it("returns null for unknown or empty skill keys", () => {
    expect(connectorRegistry.forSkill("slack")).toBeNull();
    expect(connectorRegistry.forSkill("")).toBeNull();
    expect(connectorRegistry.forSkill("   ")).toBeNull();
    expect(connectorRegistry.forSkill(undefined)).toBeNull();
  });

  it("indexes and looks up skill keys with the same normalization (trim + lowercase)", () => {
    const connector: Connector = {
      id: "spacey",
      label: "Spacey",
      summary: "",
      services: ["x"],
      skills: [" Spacey-Skill "],
      available: true,
      auth: new DirectAuth({
        url: "https://spacey",
        howto: "",
        validate: async () => ({ ok: true }),
      }),
    };
    const registry = new ConnectorRegistry([connector]);
    expect(registry.forSkill("spacey-skill")?.id).toBe("spacey");
    expect(registry.forSkill("  SPACEY-SKILL  ")?.id).toBe("spacey");
  });

  it("is the inverse of every connector's skills list", () => {
    for (const c of connectorRegistry.all()) {
      for (const skillKey of c.skills) {
        expect(connectorRegistry.forSkill(skillKey)?.id).toBe(c.id);
      }
    }
  });

  it("rejects a catalog where two connectors claim the same skill", () => {
    expect(
      () => new ConnectorRegistry([connector("a", ["shared"]), connector("b", ["shared"])]),
    ).toThrow(/claimed by connectors/);
  });

  it("rejects skill claims that differ only by whitespace or casing", () => {
    expect(
      () => new ConnectorRegistry([connector("a", ["shared"]), connector("b", ["  SHARED  "])]),
    ).toThrow(/claimed by connectors/);
  });

  it("rejects whitespace-only skill keys", () => {
    expect(() => new ConnectorRegistry([connector("a", ["   "])])).toThrow(/empty skill key/);
  });
});
