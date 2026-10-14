/**
 * The connector -> skills relationship, resolved against a user's stored
 * connections. A connector links to many skills (see `Connector.skills`), and a
 * single captured credential is meant to enable that whole set at once. These pure
 * helpers answer "which skills does this owner's set of connections enable?" without
 * touching how a credential is actually injected into a box (that materialization is
 * a separate layer): they map connection status + the catalog to a set of skill keys.
 *
 * Only a `linked` connection enables its skills. A `not_linked` or `needs_reauth`
 * connection has no usable credential, so it enables nothing until it is (re)linked.
 */

import type { StoredConnection } from "./connections-store.js";
import type { ConnectorRegistry } from "./connectors.js";

/**
 * Skill keys a single connection enables. Empty unless the connection is `linked`
 * and its connector is still in the catalog (a connection can outlive a connector
 * that was removed from the catalog, so the lookup can miss).
 */
export function skillsEnabledByConnection(
  connection: StoredConnection,
  registry: ConnectorRegistry,
): readonly string[] {
  if (connection.status !== "linked") {
    return [];
  }
  return registry.get(connection.connectorId)?.skills ?? [];
}

/**
 * The deduped union of skill keys enabled across an owner's connections, in first-
 * seen order. This is the single-credential-enables-many relationship applied to the
 * whole set: every `linked` connection contributes all of its connector's skills.
 */
export function enabledSkillKeys(
  connections: readonly StoredConnection[],
  registry: ConnectorRegistry,
): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const connection of connections) {
    for (const skillKey of skillsEnabledByConnection(connection, registry)) {
      if (!seen.has(skillKey)) {
        seen.add(skillKey);
        ordered.push(skillKey);
      }
    }
  }
  return ordered;
}
