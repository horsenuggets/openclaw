/**
 * Connector catalog. A *connector* is a catalog entry (the Todoist connector,
 * same for everyone); a *connection* is one user's authenticated instance of it
 * (stored per-instance, see connections-store.ts). Each connector carries its
 * display metadata plus the auth strategy it uses to link (see connector-auth.ts);
 * the registry is the single lookup surface the router and handler share.
 *
 * Phase 1 MVP ships the `PasteTokenAuth` connectors (Todoist, Notion, GitHub) end
 * to end. Google is catalogued with `CliAuth` (gog) but marked unavailable until
 * the in-container credential path is resolved, so `/connections` shows it as
 * "coming soon" rather than hiding the top-priority service.
 */

import { validateGithub, validateNotion, validateTodoist } from "./connect-validators.js";
import { CliAuth, type ConnectorAuth, PasteTokenAuth } from "./connector-auth.js";

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
  /** How this connector authenticates (paste a token, a CLI flow, OAuth, ...). */
  auth: ConnectorAuth;
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
   * The connector that owns a skill key (case-insensitive), or null when no
   * connector enables it. This is the inverse of {@link Connector.skills}, and it
   * is unambiguous: the constructor guarantees each skill belongs to exactly one
   * connector, so the lookup can never silently drop a competing owner.
   */
  forSkill(skillKey: string | undefined): Connector | null {
    if (!skillKey) {
      return null;
    }
    return this.bySkill.get(normalizeSkillKey(skillKey)) ?? null;
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
    // Google needs the in-container credential path resolved first (see the
    // "Resolve the no-credentials-in-box gap" task), so it is catalogued but not
    // yet linkable in this prototype.
    available: false,
    auth: new CliAuth({ tool: "gog" }),
  },
  {
    id: "todoist",
    label: "Todoist",
    summary: "Read and manage your Todoist tasks, projects, and labels.",
    services: ["Tasks", "Projects", "Labels"],
    skills: ["todoist"],
    available: true,
    auth: new PasteTokenAuth({
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
    auth: new PasteTokenAuth({
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
    auth: new PasteTokenAuth({
      url: "https://github.com/settings/personal-access-tokens",
      howto: "Create a fine-grained personal access token with the scopes you want to grant.",
      validate: validateGithub,
    }),
  },
]);
