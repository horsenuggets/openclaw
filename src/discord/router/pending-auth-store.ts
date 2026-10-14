import fs from "node:fs";
import path from "node:path";

/**
 * Per-owner persistence for an in-flight OAuth link's between-step state (the PKCE
 * `pending` blob: a code verifier + CSRF state). `begin()` mints it and the user
 * then runs a SECOND `/connections add` command to finish, so the blob must survive
 * between two separate commands (and a gateway restart). Each agent instance owns a
 * `.pending-auth.json` alongside `.connections.json`, keyed by connector id and bound
 * to the current owner so a re-registration cannot complete a previous owner's flow.
 *
 * The blob is short-lived and opaque here (the flow serialized it); it is removed
 * once the exchange succeeds. It is credential-adjacent (the verifier proves the
 * exchange), so the file uses the same owner-only (0600), atomic-write discipline as
 * the connections store.
 */

export const PENDING_AUTH_FILENAME = ".pending-auth.json";

type PendingAuthFile = { ownerId: string; pending: Record<string, string> };

function filePath(instanceDir: string): string {
  return path.join(instanceDir, PENDING_AUTH_FILENAME);
}

/** Atomic, owner-only (0600) write via a temp file + rename, matching the token store. */
function writePendingAuthFile(instanceDir: string, file: PendingAuthFile): void {
  const pathname = filePath(instanceDir);
  const tmp = `${pathname}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, pathname);
}

/**
 * Read for a read-modify-write. A genuinely absent file (ENOENT) reads as empty; a
 * present-but-corrupt file throws so a save never clobbers a readable one blindly. A
 * file bound to a different or unknown owner reads as empty, so a re-registered owner
 * starts clean and cannot resume a prior owner's pending flow.
 */
function readPendingAuthFileForWrite(instanceDir: string, ownerId: string): PendingAuthFile {
  const pathname = filePath(instanceDir);
  let raw: string;
  try {
    raw = fs.readFileSync(pathname, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      return { ownerId, pending: {} };
    }
    throw err;
  }
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Malformed pending-auth file at ${pathname}`);
  }
  const file = parsed as Record<string, unknown>;
  const pending = file.pending;
  if (pending && typeof pending === "object" && !Array.isArray(pending)) {
    if (file.ownerId !== ownerId) {
      return { ownerId, pending: {} };
    }
    // Keep only string entries so a junk value cannot crash a later read.
    const clean: Record<string, string> = {};
    for (const [id, value] of Object.entries(pending as Record<string, unknown>)) {
      if (typeof value === "string") {
        clean[id] = value;
      }
    }
    return { ownerId, pending: clean };
  }
  throw new Error(`Malformed pending-auth file at ${pathname}`);
}

/** Read leniently for a get: a missing/corrupt/wrong-owner file reads as empty. */
function readPendingAuthFile(instanceDir: string, ownerId: string): PendingAuthFile {
  try {
    return readPendingAuthFileForWrite(instanceDir, ownerId);
  } catch {
    return { ownerId, pending: {} };
  }
}

/** Store (or replace) the pending blob for a connector. Throws on a corrupt file. */
export function savePendingAuth(
  instanceDir: string,
  ownerId: string,
  connectorId: string,
  pending: string,
): void {
  const file = readPendingAuthFileForWrite(instanceDir, ownerId);
  file.pending[connectorId] = pending;
  writePendingAuthFile(instanceDir, file);
}

/** The pending blob for a connector, or null when none is in flight. */
export function getPendingAuth(
  instanceDir: string,
  ownerId: string,
  connectorId: string,
): string | null {
  return readPendingAuthFile(instanceDir, ownerId).pending[connectorId] ?? null;
}

/**
 * Drop the pending blob for a connector (after the exchange completes). A missing or
 * corrupt file is a no-op: there is nothing to clean up and a get already reads it as
 * empty, so an unreadable file must not throw on the success path.
 */
export function removePendingAuth(instanceDir: string, ownerId: string, connectorId: string): void {
  let file: PendingAuthFile;
  try {
    file = readPendingAuthFileForWrite(instanceDir, ownerId);
  } catch {
    return;
  }
  if (!(connectorId in file.pending)) {
    return;
  }
  delete file.pending[connectorId];
  writePendingAuthFile(instanceDir, file);
}
