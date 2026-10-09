import fs from "node:fs";
import path from "node:path";

/**
 * Per-owner persistence for connections (a user's authenticated links to
 * external services). Each agent instance owns a `.connections.json` in its
 * instance directory, alongside `.onboarding.json` and `.port`; the file is
 * bound to the current owner so re-registration cannot expose a previous owner's
 * credentials. The file is container-private; v1 stores the credential here
 * (the agent box reads its own `/state`). The clean end-state is a router-side
 * broker (Phase 3) so the token never lives next to the box at all.
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

type ConnectionsFile = { ownerId: string; connections: Record<string, StoredConnection> };

const CONNECTION_STATUSES: ReadonlySet<string> = new Set<ConnectionStatus>([
  "linked",
  "not_linked",
  "needs_reauth",
]);

/**
 * Validate one stored record before it is handed to callers that dereference it
 * (e.g. `listReply` reading `connectorId`/`status`). A valid JSON file can still
 * hold a junk entry such as `{"github": null}`; dropping it here keeps a single
 * bad record from crashing the whole command.
 */
function isStoredConnection(value: unknown): value is StoredConnection {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.connectorId === "string" &&
    typeof record.status === "string" &&
    CONNECTION_STATUSES.has(record.status) &&
    typeof record.linkedAt === "string" &&
    (record.token === undefined || typeof record.token === "string") &&
    (record.accountLabel === undefined || typeof record.accountLabel === "string")
  );
}

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
 * file or a file bound to another/unknown owner reads as "no connections". Safe
 * for list/get, which never write back.
 * Writers must use {@link readConnectionsFileForWrite} instead, so they never
 * overwrite a corrupt file and discard its contents.
 */
export function readConnectionsFile(instanceDir: string, ownerId: string): ConnectionsFile {
  try {
    return readConnectionsFileForWrite(instanceDir, ownerId);
  } catch {
    return { ownerId, connections: {} };
  }
}

/**
 * Read for a read-modify-write. Only a genuinely absent file (ENOENT) counts as
 * "no connections"; a present-but-corrupt or wrong-shape file throws rather than
 * reading as empty, so a subsequent save/remove refuses instead of silently
 * clobbering previously stored connections. A valid file bound to a different or
 * unknown owner is treated as empty, preventing credentials from crossing owners.
 * Other read errors (permissions, I/O) also throw.
 */
function readConnectionsFileForWrite(instanceDir: string, ownerId: string): ConnectionsFile {
  const pathname = filePath(instanceDir);
  let raw: string;
  try {
    raw = fs.readFileSync(pathname, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      return { ownerId, connections: {} };
    }
    throw err;
  }
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Malformed connections file at ${pathname}`);
  }
  const file = parsed as Record<string, unknown>;
  const connections = file.connections;
  if (connections && typeof connections === "object" && !Array.isArray(connections)) {
    if (file.ownerId !== ownerId) {
      return { ownerId, connections: {} };
    }
    // Keep only well-formed records so a junk entry (e.g. a null value) cannot
    // crash a later dereference; a wrong-typed outer object still throws below.
    const clean: Record<string, StoredConnection> = {};
    for (const [id, record] of Object.entries(connections as Record<string, unknown>)) {
      if (isStoredConnection(record)) {
        clean[id] = record;
      }
    }
    return { ownerId, connections: clean };
  }
  throw new Error(`Malformed connections file at ${pathname}`);
}

/** All stored connections for an instance, in insertion order. */
export function listConnections(instanceDir: string, ownerId: string): StoredConnection[] {
  return Object.values(readConnectionsFile(instanceDir, ownerId).connections);
}

/** A single connection by connector id, or null when not linked. */
export function getConnection(
  instanceDir: string,
  ownerId: string,
  connectorId: string,
): StoredConnection | null {
  return readConnectionsFile(instanceDir, ownerId).connections[connectorId] ?? null;
}

/**
 * Create or replace a connection, preserving the other entries. Throws if the
 * existing file is corrupt (rather than discarding its contents); callers treat a
 * throw as a storage failure.
 */
export function saveConnection(
  instanceDir: string,
  ownerId: string,
  connection: StoredConnection,
): void {
  const file = readConnectionsFileForWrite(instanceDir, ownerId);
  file.connections[connection.connectorId] = connection;
  writeConnectionsFile(instanceDir, file);
}

/**
 * Remove a connection. Returns true when one was removed, false when absent.
 * Throws if the existing file is corrupt, so the caller can report a failure
 * instead of silently rewriting (and discarding) a malformed file.
 */
export function removeConnection(
  instanceDir: string,
  ownerId: string,
  connectorId: string,
): boolean {
  const file = readConnectionsFileForWrite(instanceDir, ownerId);
  if (!(connectorId in file.connections)) {
    return false;
  }
  delete file.connections[connectorId];
  writeConnectionsFile(instanceDir, file);
  return true;
}
