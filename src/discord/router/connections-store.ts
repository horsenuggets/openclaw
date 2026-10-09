import fs from "node:fs";
import path from "node:path";

/**
 * Per-instance persistence for connections (a user's authenticated links to
 * external services). Each agent instance owns a `.connections.json` in its
 * instance directory, alongside `.onboarding.json` and `.port`. The file is
 * container-private; v1 stores the credential here (the agent box reads its own
 * `/state`). The clean end-state is a router-side broker (Phase 3) so the token
 * never lives next to the box at all.
 */

export const CONNECTIONS_FILENAME = ".connections.json";

export type ConnectionStatus = "linked" | "not_linked" | "needs_reauth";

export type StoredConnection = {
  connectorId: string;
  status: ConnectionStatus;
  /** The secret for paste-token connectors. Absent once Phase 3 brokers tokens. */
  token?: string;
  /** Account label discovered during validation (e.g. the GitHub login). */
  accountLabel?: string;
  /** ISO-8601 time the connection was created or last re-authed. */
  linkedAt: string;
};

type ConnectionsFile = { connections: Record<string, StoredConnection> };

function filePath(instanceDir: string): string {
  return path.join(instanceDir, CONNECTIONS_FILENAME);
}

/**
 * Persist the file. Tokens live here, so match the credential-file convention in
 * `src/infra/json-file.ts`: a trailing newline and owner-only (0600) permissions.
 * The chmod runs on every write (not just creation, which is all a writeFileSync
 * `mode` option would cover) so an existing file left world-readable by a prior
 * umask is tightened too.
 */
function writeConnectionsFile(instanceDir: string, file: ConnectionsFile): void {
  const pathname = filePath(instanceDir);
  fs.writeFileSync(pathname, `${JSON.stringify(file, null, 2)}\n`, "utf8");
  fs.chmodSync(pathname, 0o600);
}

/** Read the connections file, tolerating a missing or malformed file. */
export function readConnectionsFile(instanceDir: string): ConnectionsFile {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath(instanceDir), "utf-8"));
    const connections = raw?.connections;
    if (connections && typeof connections === "object" && !Array.isArray(connections)) {
      return { connections: connections as Record<string, StoredConnection> };
    }
  } catch {
    // Missing or unreadable: treat as no connections.
  }
  return { connections: {} };
}

/** All stored connections for an instance, in insertion order. */
export function listConnections(instanceDir: string): StoredConnection[] {
  return Object.values(readConnectionsFile(instanceDir).connections);
}

/** A single connection by connector id, or null when not linked. */
export function getConnection(instanceDir: string, connectorId: string): StoredConnection | null {
  return readConnectionsFile(instanceDir).connections[connectorId] ?? null;
}

/** Create or replace a connection, preserving the other entries. */
export function saveConnection(instanceDir: string, connection: StoredConnection): void {
  const file = readConnectionsFile(instanceDir);
  file.connections[connection.connectorId] = connection;
  writeConnectionsFile(instanceDir, file);
}

/** Remove a connection. Returns true when one was removed, false when absent. */
export function removeConnection(instanceDir: string, connectorId: string): boolean {
  const file = readConnectionsFile(instanceDir);
  if (!(connectorId in file.connections)) {
    return false;
  }
  delete file.connections[connectorId];
  writeConnectionsFile(instanceDir, file);
  return true;
}
