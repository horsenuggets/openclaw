import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  PENDING_AUTH_FILENAME,
  getPendingAuth,
  removePendingAuth,
  savePendingAuth,
} from "./pending-auth-store.js";

const OWNER = "owner-1";

describe("pending-auth-store", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "pending-auth-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns null when nothing is stored", () => {
    expect(getPendingAuth(dir, OWNER, "google")).toBeNull();
  });

  it("round-trips a pending blob per connector", () => {
    savePendingAuth(dir, OWNER, "google", "blob-g");
    savePendingAuth(dir, OWNER, "slack", "blob-s");
    expect(getPendingAuth(dir, OWNER, "google")).toBe("blob-g");
    expect(getPendingAuth(dir, OWNER, "slack")).toBe("blob-s");
  });

  it("replaces an existing blob for the same connector", () => {
    savePendingAuth(dir, OWNER, "google", "first");
    savePendingAuth(dir, OWNER, "google", "second");
    expect(getPendingAuth(dir, OWNER, "google")).toBe("second");
  });

  it("removes a blob and leaves the others", () => {
    savePendingAuth(dir, OWNER, "google", "blob-g");
    savePendingAuth(dir, OWNER, "slack", "blob-s");
    removePendingAuth(dir, OWNER, "google");
    expect(getPendingAuth(dir, OWNER, "google")).toBeNull();
    expect(getPendingAuth(dir, OWNER, "slack")).toBe("blob-s");
  });

  it("remove is a no-op when the connector or file is absent", () => {
    expect(() => removePendingAuth(dir, OWNER, "google")).not.toThrow();
    savePendingAuth(dir, OWNER, "slack", "blob-s");
    expect(() => removePendingAuth(dir, OWNER, "google")).not.toThrow();
    expect(getPendingAuth(dir, OWNER, "slack")).toBe("blob-s");
  });

  it("isolates pending state per owner", () => {
    savePendingAuth(dir, OWNER, "google", "mine");
    // A different owner (e.g. after re-registration) must not see it.
    expect(getPendingAuth(dir, "owner-2", "google")).toBeNull();
    // ...and writing as the new owner replaces the file's owner binding.
    savePendingAuth(dir, "owner-2", "google", "theirs");
    expect(getPendingAuth(dir, "owner-2", "google")).toBe("theirs");
    expect(getPendingAuth(dir, OWNER, "google")).toBeNull();
  });

  it("writes the file owner-only (0600)", () => {
    savePendingAuth(dir, OWNER, "google", "blob");
    const mode = fs.statSync(path.join(dir, PENDING_AUTH_FILENAME)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("reads a corrupt file leniently as empty for a get", () => {
    fs.writeFileSync(path.join(dir, PENDING_AUTH_FILENAME), "{ not json", "utf8");
    expect(getPendingAuth(dir, OWNER, "google")).toBeNull();
  });

  it("refuses to clobber a corrupt file on save", () => {
    fs.writeFileSync(path.join(dir, PENDING_AUTH_FILENAME), "{ not json", "utf8");
    expect(() => savePendingAuth(dir, OWNER, "google", "blob")).toThrow();
  });
});
