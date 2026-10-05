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

  it("tolerates a malformed file as no connections", () => {
    fs.writeFileSync(path.join(dir, CONNECTIONS_FILENAME), "{ not json");
    expect(listConnections(dir)).toEqual([]);
    // And a save over a corrupt file still works.
    saveConnection(dir, conn());
    expect(getConnection(dir, "todoist")?.token).toBe("tok_123");
  });
});
