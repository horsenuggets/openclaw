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
 * Persist the file atomically. Tokens live here, so match the credential-file
 * convention in `src/infra/json-file.ts`: a trailing newline and owner-only
 * (0600) permissions. Write to a temp file (created 0600, then chmod'd in case a
 * prior temp existed) and rename it into place, so an interrupted write can never
 * leave a truncated/corrupt credential file. The chmod runs on every write so an
 * existing file left world-readable by a prior umask is tightened too.
 */
function writeConnectionsFile(instanceDir: string, file: ConnectionsFile): void {
  const pathname = filePath(instanceDir);
  const tmp = `${pathname}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, pathname);
}

/**
 * Read the connections file leniently for display: a missing OR unreadable/corrupt
 * file reads as "no connections". Safe for list/get, which never write back.
 * Writers must use {@link readConnectionsFileForWrite} instead, so they never
 * overwrite a corrupt file and discard its contents.
 */
export function readConnectionsFile(instanceDir: string): ConnectionsFile {
  try {
    return readConnectionsFileForWrite(instanceDir);
  } catch {
    return { connections: {} };
  }
}

/**
 * Read for a read-modify-write. Only a genuinely absent file (ENOENT) counts as
 * "no connections"; a present-but-corrupt or wrong-shape file throws rather than
 * reading as empty, so a subsequent save/remove refuses instead of silently
 * clobbering previously stored connections. Other read errors (permissions, I/O)
 * also throw.
 */
function readConnectionsFileForWrite(instanceDir: string): ConnectionsFile {
  const pathname = filePath(instanceDir);
  let raw: string;
  try {
    raw = fs.readFileSync(pathname, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      return { connections: {} };
    }
    throw err;
  }
  const parsed = JSON.parse(raw) as { connections?: unknown };
  const connections = parsed?.connections;
  if (connections && typeof connections === "object" && !Array.isArray(connections)) {
    return { connections: connections as Record<string, StoredConnection> };
  }
  throw new Error(`Malformed connections file at ${pathname}`);
}

/** All stored connections for an instance, in insertion order. */
export function listConnections(instanceDir: string): StoredConnection[] {
  return Object.values(readConnectionsFile(instanceDir).connections);
}

/** A single connection by connector id, or null when not linked. */
export function getConnection(instanceDir: string, connectorId: string): StoredConnection | null {
  return readConnectionsFile(instanceDir).connections[connectorId] ?? null;
}

/**
 * Create or replace a connection, preserving the other entries. Throws if the
 * existing file is corrupt (rather than discarding its contents); callers treat a
 * throw as a storage failure.
 */
export function saveConnection(instanceDir: string, connection: StoredConnection): void {
  const file = readConnectionsFileForWrite(instanceDir);
  file.connections[connection.connectorId] = connection;
  writeConnectionsFile(instanceDir, file);
}

/**
 * Remove a connection. Returns true when one was removed, false when absent.
 * Throws if the existing file is corrupt, so the caller can report a failure
 * instead of silently rewriting (and discarding) a malformed file.
 */
export function removeConnection(instanceDir: string, connectorId: string): boolean {
  const file = readConnectionsFileForWrite(instanceDir);
  if (!(connectorId in file.connections)) {
    return false;
  }
  delete file.connections[connectorId];
  writeConnectionsFile(instanceDir, file);
  return true;
}
