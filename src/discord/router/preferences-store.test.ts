import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  deleteUserPreferences,
  readUserPreferences,
  userPreferencesPath,
  writeUserPreferences,
} from "./preferences-store.js";

const CHANNEL = "123456789012345678";

let instancesDir: string;

beforeEach(() => {
  instancesDir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-prefs-"));
});

afterEach(() => {
  fs.rmSync(instancesDir, { recursive: true, force: true });
});

it("stores preferences under shared/preferences, separate from the instance dir", () => {
  expect(userPreferencesPath(instancesDir, CHANNEL)).toBe(
    path.join(instancesDir, "shared", "preferences", `${CHANNEL}.json`),
  );
});

it("reads an empty object when nothing is stored", () => {
  expect(readUserPreferences(instancesDir, CHANNEL)).toEqual({});
});

it("round-trips a written preference, creating the subtree on demand", () => {
  // The shared/preferences directory does not exist yet; the write must create it.
  writeUserPreferences(instancesDir, CHANNEL, { lifecycleMessages: true });
  expect(readUserPreferences(instancesDir, CHANNEL)).toEqual({ lifecycleMessages: true });
});

it("overwrites a prior value rather than merging stale state", () => {
  writeUserPreferences(instancesDir, CHANNEL, { lifecycleMessages: true });
  writeUserPreferences(instancesDir, CHANNEL, { lifecycleMessages: false });
  expect(readUserPreferences(instancesDir, CHANNEL)).toEqual({ lifecycleMessages: false });
});

it("reads an empty object when the file holds malformed JSON", () => {
  const file = userPreferencesPath(instancesDir, CHANNEL);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "{ not json");
  expect(readUserPreferences(instancesDir, CHANNEL)).toEqual({});
});

it("reads an empty object when the stored value is not an object", () => {
  const file = userPreferencesPath(instancesDir, CHANNEL);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "[1, 2, 3]");
  expect(readUserPreferences(instancesDir, CHANNEL)).toEqual({});
});

it("deletes a channel's preferences and no-ops when already absent", () => {
  writeUserPreferences(instancesDir, CHANNEL, { lifecycleMessages: true });
  deleteUserPreferences(instancesDir, CHANNEL);
  expect(fs.existsSync(userPreferencesPath(instancesDir, CHANNEL))).toBe(false);
  // Deleting again must not throw.
  expect(() => deleteUserPreferences(instancesDir, CHANNEL)).not.toThrow();
});

it("writeUserPreferences throws when the subtree cannot be created", () => {
  // Simulate a write that cannot land (the read-only-mount condition that used to
  // fail silently): put a regular file where the shared/ directory must be, so the
  // recursive mkdir throws ENOTDIR regardless of uid (root bypasses chmod perms).
  fs.writeFileSync(path.join(instancesDir, "shared"), "not a directory");
  expect(() => writeUserPreferences(instancesDir, CHANNEL, { lifecycleMessages: true })).toThrow();
});
