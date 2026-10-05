/**
 * Connector catalog: the reusable definitions (types) a user can turn into a
 * connection. A *connector* is the catalog entry (the Todoist connector, same
 * for everyone); a *connection* is one user's authenticated instance of it
 * (stored per-instance, see connections-store.ts).
 *
 * Phase 1 MVP ships the `paste-token` connectors (Todoist, Notion, GitHub)
 * end to end. Google is listed via the `cli` kind (gog) but marked unavailable
 * until the in-container credential path is resolved; `oauth-pkce` connectors
 * come in Phase 2. Keeping Google in the catalog lets `/connect` show it as
 * "coming soon" rather than hiding the top-priority service.
 */

export type ConnectorAuthKind = "paste-token" | "oauth-pkce" | "cli";

export type ConnectorDef = {
  id: string;
  /** User-facing name, e.g. "Todoist". */
  label: string;
  authKind: ConnectorAuthKind;
  /** One-line description of what linking this unlocks. */
  summary: string;
  /** Services the connection exposes, e.g. ["Tasks", "Projects"]. */
  services: string[];
  /** False while the connector is catalogued but not wired yet (shown as coming soon). */
  available: boolean;
  /** Human instructions for where to create the token (paste-token kinds). */
  tokenHowto?: string;
  /** Link the user opens to create the token (paste-token kinds). */
  tokenUrl?: string;
};

/**
 * The catalog, ordered for display. Order is intentional: the two short-term
 * priorities (Google, Todoist) come first.
 */
export const CONNECTORS: readonly ConnectorDef[] = [
  {
    id: "google",
    label: "Google",
    authKind: "cli",
    summary: "Gmail, Calendar, Drive, Contacts, Sheets, and Docs via the gog CLI.",
    services: ["Gmail", "Calendar", "Drive", "Contacts", "Sheets", "Docs"],
    // Google needs the in-container credential path resolved first (see the
    // "Resolve the no-credentials-in-box gap" task), so it is catalogued but
    // not yet linkable in this prototype.
    available: false,
  },
  {
    id: "todoist",
    label: "Todoist",
    authKind: "paste-token",
    summary: "Read and manage your Todoist tasks, projects, and labels.",
    services: ["Tasks", "Projects", "Labels"],
    available: true,
    tokenHowto: "Todoist → Settings → Integrations → Developer → copy your API token.",
    tokenUrl: "https://app.todoist.com/app/settings/integrations/developer",
  },
  {
    id: "notion",
    label: "Notion",
    authKind: "paste-token",
    summary: "Read and edit Notion pages and databases you share with the integration.",
    services: ["Pages", "Databases", "Comments"],
    available: true,
    tokenHowto:
      "Create an internal integration, copy its secret, then share the pages you want it to see.",
    tokenUrl: "https://www.notion.so/my-integrations",
  },
  {
    id: "github",
    label: "GitHub",
    authKind: "paste-token",
    summary: "Access repositories, issues, and pull requests on your behalf.",
    services: ["Repos", "Issues", "Pull requests"],
    available: true,
    tokenHowto: "Create a fine-grained personal access token with the scopes you want to grant.",
    tokenUrl: "https://github.com/settings/personal-access-tokens",
  },
] as const;

/** Look up a connector by id (case-insensitive). Returns null when unknown. */
export function getConnector(id: string | undefined): ConnectorDef | null {
  if (!id) {
    return null;
  }
  const needle = id.trim().toLowerCase();
  return CONNECTORS.find((c) => c.id === needle) ?? null;
}

/** Comma-separated list of connector ids a user can add right now. */
export function availableConnectorIds(): string {
  return CONNECTORS.filter((c) => c.available)
    .map((c) => c.id)
    .join(", ");
}
