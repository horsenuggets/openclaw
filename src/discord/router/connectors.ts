/**
 * Connector catalog. A *connector* is a catalog entry (the Todoist connector,
 * same for everyone); a *connection* is one user's authenticated instance of it
 * (stored per-instance, see connections-store.ts). Each connector carries its
 * display metadata plus the auth flow it uses to link (see auth-flow.ts); the
 * registry is the single lookup surface the router and handler share.
 *
 * The `DirectAuth` connectors (Todoist, Notion, GitHub) link end to end — the user
 * pastes a personal token. Google uses `OAuthPkceAuth` (the two-step PKCE flow) but is
 * marked unavailable until the deployment sets its client id and the captured credential
 * materializes into the agent box, so `/connections` shows it as "coming soon" rather
 * than hiding the top-priority service.
 */

import { type AuthFlow, DirectAuth, OAuthPkceAuth } from "./auth-flow.js";
import { validateGithub, validateNotion, validateTodoist } from "./connect-validators.js";

export type Connector = {
  id: string;
  /** User-facing name, e.g. "Todoist". */
  label: string;
  /** One-line description of what linking this unlocks. */
  summary: string;
  /** Services the connection exposes, e.g. ["Tasks", "Projects"]. */
  services: readonly string[];
  /**
   * Skill keys (SKILL.md `name`/`skillKey`) this connector's single credential
   * enables. One connector links to MANY skills: a Google credential enables every
   * Google skill, a Todoist token enables the Todoist skill, and so on. Materializing
   * one captured credential enables this whole set at once (the mechanics of injecting
   * that credential per skill live elsewhere; this is only the linkage).
   */
  skills: readonly string[];
  /** False while the connector is catalogued but not wired yet (shown as coming soon). */
  available: boolean;
  /** How this connector authenticates (a direct token paste, OAuth, a CLI flow). */
  auth: AuthFlow;
};

/**
 * Canonical form of a skill key. Skill-key identity is case-insensitive and
 * whitespace-insensitive, so every place that indexes, looks up, or dedupes a skill
 * key must normalize through this one function to keep those operations consistent.
 */
export function normalizeSkillKey(skillKey: string): string {
  return skillKey.trim().toLowerCase();
}

/**
 * Registry over the connector catalog: the single lookup surface for the router
 * (building slash-command choices) and the command handler (resolving a service
 * the user named). Lookups are case-insensitive.
 */
export class ConnectorRegistry {
  private readonly byId: Map<string, Connector>;
  /** Reverse index from a skill key to the connector that enables it. */
  private readonly bySkill: Map<string, Connector>;

  constructor(private readonly connectors: readonly Connector[]) {
    this.byId = new Map(connectors.map((c) => [c.id, c]));
    // A skill belongs to exactly one connector (its credential materializes that
    // skill). Build the reverse index fail-fast: a skill claimed by two connectors
    // is a catalog bug — the credential that powers it would be ambiguous and the
    // index would silently drop one owner — so reject it at construction rather than
    // let `forSkill` return an arbitrary winner. A connector may list the same skill
    // twice harmlessly (it still has one owner); only cross-connector claims throw.
    this.bySkill = new Map();
    for (const connector of connectors) {
      for (const skillKey of connector.skills) {
        const key = normalizeSkillKey(skillKey);
        if (!key) {
          throw new Error(`Connector "${connector.id}" has an empty skill key`);
        }
        const owner = this.bySkill.get(key);
        if (owner && owner.id !== connector.id) {
          throw new Error(
            `Skill "${skillKey}" is claimed by connectors "${owner.id}" and "${connector.id}"; each skill must belong to exactly one connector`,
          );
        }
        this.bySkill.set(key, connector);
      }
    }
  }

  /** Every connector, in display order. */
  all(): readonly Connector[] {
    return this.connectors;
  }

  /** Look up a connector by id (case-insensitive). Returns null when unknown. */
  get(id: string | undefined): Connector | null {
    if (!id) {
      return null;
    }
    return this.byId.get(id.trim().toLowerCase()) ?? null;
  }

  /**
   * The connector that owns a skill key (trimmed and case-insensitive), or null when
   * no connector enables it. This is the inverse of {@link Connector.skills}, and it
   * is unambiguous: the constructor guarantees each skill belongs to exactly one
   * connector, so the lookup can never silently drop a competing owner.
   */
  forSkill(skillKey: string | undefined): Connector | null {
    if (!skillKey) {
      return null;
    }
    const key = normalizeSkillKey(skillKey);
    if (!key) {
      return null;
    }
    return this.bySkill.get(key) ?? null;
  }

  /** Connectors a user can link right now. */
  available(): Connector[] {
    return this.connectors.filter((c) => c.available);
  }

  /** Comma-separated ids a user can add right now (for error messages). */
  availableIds(): string {
    return this.available()
      .map((c) => c.id)
      .join(", ");
  }
}

/**
 * Google OAuth. Endpoints and scopes are public, universal constants (safe to keep
 * in the repo). The client id is also public protocol config — it rides in every
 * authorize URL, so it is NOT a secret — but it is per-deployment, so it is read from
 * the environment at call time rather than hardcoded, and the connector stays
 * unavailable until it is set (and the credential materializes into the box). The
 * loopback redirect follows the native-app flow (RFC 8252): the user approves and is
 * sent to `http://127.0.0.1`, where nothing need listen — the code is in the URL,
 * which they paste back. `access_type=offline` + `prompt=consent` ask Google for a
 * refresh token so the link can outlive the short-lived access token.
 */
const GOOGLE_AUTHORIZE_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_ENDPOINT = "https://www.googleapis.com/oauth2/v2/userinfo";
const GOOGLE_REDIRECT_URI = "http://127.0.0.1";
const GOOGLE_SCOPES: readonly string[] = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/contacts",
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/documents",
];

/** Name the Google account from an access token via the userinfo endpoint. */
async function identifyGoogleAccount(accessToken: string): Promise<string | undefined> {
  const res = await fetch(GOOGLE_USERINFO_ENDPOINT, {
    headers: { authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    return undefined;
  }
  const body = (await res.json()) as { email?: unknown };
  return typeof body.email === "string" ? body.email : undefined;
}

/**
 * The shared catalog, ordered for display. Order is intentional: the two
 * short-term priorities (Google, Todoist) come first.
 */
export const connectorRegistry = new ConnectorRegistry([
  {
    id: "google",
    label: "Google",
    summary: "Gmail, Calendar, Drive, Contacts, Sheets, and Docs via the gog CLI.",
    services: ["Gmail", "Calendar", "Drive", "Contacts", "Sheets", "Docs"],
    skills: ["gog"],
    // Google authenticates via OAuth (PKCE, paste-based), but linking stays disabled
    // until (a) the deployment sets OPENCLAW_GOOGLE_CLIENT_ID and (b) the captured
    // credential actually materializes into the agent box (gog reads a credential
    // file, not an env token — that is the materialization step). Flip to true once
    // both land.
    available: false,
    auth: new OAuthPkceAuth({
      authorizeEndpoint: GOOGLE_AUTHORIZE_ENDPOINT,
      tokenEndpoint: GOOGLE_TOKEN_ENDPOINT,
      clientId: () => process.env.OPENCLAW_GOOGLE_CLIENT_ID,
      redirectUri: GOOGLE_REDIRECT_URI,
      scopes: GOOGLE_SCOPES,
      extraAuthParams: { access_type: "offline", prompt: "consent" },
      howto:
        "Open the link to approve access to your Google account, then paste the " +
        "http://127.0.0.1 URL your browser is sent to (it will not load — that is fine).",
      identify: identifyGoogleAccount,
    }),
  },
  {
    id: "todoist",
    label: "Todoist",
    summary: "Read and manage your Todoist tasks, projects, and labels.",
    services: ["Tasks", "Projects", "Labels"],
    skills: ["todoist"],
    available: true,
    auth: new DirectAuth({
      url: "https://app.todoist.com/app/settings/integrations/developer",
      howto: "Todoist » Settings » Integrations » Developer » copy your API token.",
      validate: validateTodoist,
    }),
  },
  {
    id: "notion",
    label: "Notion",
    summary: "Read and edit Notion pages and databases you share with the integration.",
    services: ["Pages", "Databases", "Comments"],
    skills: ["notion"],
    available: true,
    auth: new DirectAuth({
      url: "https://www.notion.so/my-integrations",
      howto:
        "Create an internal integration, copy its secret, then share the pages you want it to see.",
      validate: validateNotion,
    }),
  },
  {
    id: "github",
    label: "GitHub",
    summary: "Access repositories, issues, and pull requests on your behalf.",
    services: ["Repos", "Issues", "Pull requests"],
    skills: ["github"],
    available: true,
    auth: new DirectAuth({
      url: "https://github.com/settings/personal-access-tokens",
      howto: "Create a fine-grained personal access token with the scopes you want to grant.",
      validate: validateGithub,
    }),
  },
]);
