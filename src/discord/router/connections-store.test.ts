import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CONNECTIONS_FILENAME,
  type StoredConnection,
  getConnection,
  listConnections,
  readConnectionsFile,
  removeConnection,
  saveConnection,
} from "./connections-store.js";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-connections-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function conn(over: Partial<StoredConnection> = {}): StoredConnection {
  return {
    connectorId: over.connectorId ?? "todoist",
    status: over.status ?? "linked",
    token: over.token ?? "tok_123",
    linkedAt: over.linkedAt ?? "2026-01-01T00:00:00.000Z",
    ...(over.accountLabel ? { accountLabel: over.accountLabel } : {}),
  };
}

describe("connections-store", () => {
  it("returns an empty set for a fresh instance dir", () => {
    expect(listConnections(dir)).toEqual([]);
    expect(getConnection(dir, "todoist")).toBeNull();
    expect(readConnectionsFile(dir)).toEqual({ connections: {} });
  });

  it("saves and reads a connection back", () => {
    saveConnection(dir, conn({ accountLabel: "me@example.com" }));
    const stored = getConnection(dir, "todoist");
    expect(stored?.status).toBe("linked");
    expect(stored?.token).toBe("tok_123");
    expect(stored?.accountLabel).toBe("me@example.com");
    expect(fs.existsSync(path.join(dir, CONNECTIONS_FILENAME))).toBe(true);
  });

  it("replaces an existing connection without dropping the others", () => {
    saveConnection(dir, conn({ connectorId: "todoist", token: "old" }));
    saveConnection(dir, conn({ connectorId: "github", token: "gh" }));
    saveConnection(dir, conn({ connectorId: "todoist", token: "new" }));
    expect(getConnection(dir, "todoist")?.token).toBe("new");
    expect(getConnection(dir, "github")?.token).toBe("gh");
    expect(listConnections(dir)).toHaveLength(2);
  });

  it("removes a connection and reports whether one existed", () => {
    saveConnection(dir, conn());
    expect(removeConnection(dir, "todoist")).toBe(true);
    expect(getConnection(dir, "todoist")).toBeNull();
    expect(removeConnection(dir, "todoist")).toBe(false);
  });

  it("reads a malformed file as no connections for display, but refuses to clobber it", () => {
    const file = path.join(dir, CONNECTIONS_FILENAME);
    fs.writeFileSync(file, "{ not json");
    // Lenient read (list/get) shows nothing rather than crashing the command.
    expect(listConnections(dir)).toEqual([]);
    expect(getConnection(dir, "todoist")).toBeNull();
    // But a write refuses, so the corrupt file is preserved for inspection
    // instead of silently discarding whatever it held.
    expect(() => saveConnection(dir, conn())).toThrow();
    expect(() => removeConnection(dir, "todoist")).toThrow();
    expect(fs.readFileSync(file, "utf-8")).toBe("{ not json");
  });

  it("drops malformed records (e.g. a null entry) rather than returning them", () => {
    fs.writeFileSync(
      path.join(dir, CONNECTIONS_FILENAME),
      JSON.stringify({
        connections: {
          github: null,
          notion: { connectorId: "notion" }, // missing status/linkedAt
          todoist: {
            connectorId: "todoist",
            status: "linked",
            token: "t",
            linkedAt: "2026-01-01T00:00:00.000Z",
          },
        },
      }),
    );
    const list = listConnections(dir);
    expect(list).toHaveLength(1);
    expect(list[0]?.connectorId).toBe("todoist");
    expect(getConnection(dir, "github")).toBeNull();
    expect(getConnection(dir, "notion")).toBeNull();
  });

  it("writes the file atomically (no leftover temp file)", () => {
    saveConnection(dir, conn());
    const entries = fs.readdirSync(dir);
    expect(entries).toContain(CONNECTIONS_FILENAME);
    expect(entries.some((e) => e.endsWith(".tmp"))).toBe(false);
  });

  it("writes the token file owner-only (0600) with a trailing newline", () => {
    saveConnection(dir, conn());
    const file = path.join(dir, CONNECTIONS_FILENAME);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(file, "utf-8").endsWith("}\n")).toBe(true);
  });

  it("tightens an existing world-readable file to 0600 on the next write", () => {
    const file = path.join(dir, CONNECTIONS_FILENAME);
    fs.writeFileSync(file, JSON.stringify({ connections: {} }), { mode: 0o644 });
    fs.chmodSync(file, 0o644); // force the loose mode regardless of umask
    saveConnection(dir, conn());
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });
});
