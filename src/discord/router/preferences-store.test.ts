import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  clearUserPreferences,
  readEphemeralCommands,
  readUserPreferences,
  setEphemeralCommands,
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

it("does not fall back to the legacy block when the new file is present but malformed", () => {
  // A corrupt new-store file (e.g. a damaged tombstone) must read as defaults, not
  // reactivate a stale legacy setting. The fallback applies only when it is absent.
  const legacyDir = path.join(instancesDir, CHANNEL);
  fs.mkdirSync(legacyDir, { recursive: true });
  fs.writeFileSync(
    path.join(legacyDir, ".onboarding.json"),
    JSON.stringify({ preferences: { lifecycleMessages: true } }),
  );
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

it("clears a channel's preferences by writing an empty tombstone", () => {
  writeUserPreferences(instancesDir, CHANNEL, { lifecycleMessages: true });
  clearUserPreferences(instancesDir, CHANNEL);
  // The file is kept (as a tombstone), not deleted, and reads back as defaults.
  expect(fs.existsSync(userPreferencesPath(instancesDir, CHANNEL))).toBe(true);
  expect(readUserPreferences(instancesDir, CHANNEL)).toEqual({});
});

it("clear suppresses the legacy fallback so re-register does not resurrect a setting", () => {
  // The provisioner preserves the instance dir and its .onboarding.json across an
  // unregister/re-register, so a legacy lifecycle-enabled block would otherwise be
  // re-exposed by the fallback. The tombstone must win over it.
  const legacyDir = path.join(instancesDir, CHANNEL);
  fs.mkdirSync(legacyDir, { recursive: true });
  fs.writeFileSync(
    path.join(legacyDir, ".onboarding.json"),
    JSON.stringify({ preferences: { lifecycleMessages: true } }),
  );
  clearUserPreferences(instancesDir, CHANNEL);
  expect(readUserPreferences(instancesDir, CHANNEL)).toEqual({});
});

it("falls back to the legacy .onboarding.json block when the new file is absent", () => {
  // An older release persisted preferences into the per-channel .onboarding.json on a
  // writable deployment. With no new-store file yet, that value must still be read so
  // the setting is not lost on upgrade.
  const legacyDir = path.join(instancesDir, CHANNEL);
  fs.mkdirSync(legacyDir, { recursive: true });
  fs.writeFileSync(
    path.join(legacyDir, ".onboarding.json"),
    JSON.stringify({ ownerId: "123", preferences: { lifecycleMessages: true } }),
  );
  expect(readUserPreferences(instancesDir, CHANNEL)).toEqual({ lifecycleMessages: true });
});

it("prefers the new store over the legacy block when both exist", () => {
  const legacyDir = path.join(instancesDir, CHANNEL);
  fs.mkdirSync(legacyDir, { recursive: true });
  fs.writeFileSync(
    path.join(legacyDir, ".onboarding.json"),
    JSON.stringify({ preferences: { lifecycleMessages: true } }),
  );
  writeUserPreferences(instancesDir, CHANNEL, { lifecycleMessages: false });
  expect(readUserPreferences(instancesDir, CHANNEL)).toEqual({ lifecycleMessages: false });
});

it("writeUserPreferences throws when the subtree cannot be created", () => {
  // Simulate a write that cannot land (the read-only-mount condition that used to
  // fail silently): put a regular file where the shared/ directory must be, so the
  // recursive mkdir throws ENOTDIR regardless of uid (root bypasses chmod perms).
  fs.writeFileSync(path.join(instancesDir, "shared"), "not a directory");
  expect(() => writeUserPreferences(instancesDir, CHANNEL, { lifecycleMessages: true })).toThrow();
});

it("defaults ephemeral commands to true when unset", () => {
  expect(readEphemeralCommands(instancesDir, CHANNEL)).toBe(true);
});

it("reads back a stored ephemeral preference", () => {
  writeUserPreferences(instancesDir, CHANNEL, { ephemeralCommands: false });
  expect(readEphemeralCommands(instancesDir, CHANNEL)).toBe(false);
});

it("setEphemeralCommands persists without clobbering other preferences", () => {
  writeUserPreferences(instancesDir, CHANNEL, { lifecycleMessages: true });
  expect(setEphemeralCommands(instancesDir, CHANNEL, false)).toBe(true);
  expect(readUserPreferences(instancesDir, CHANNEL)).toEqual({
    lifecycleMessages: true,
    ephemeralCommands: false,
  });
});

it("clearing preferences resets ephemeral back to the default", () => {
  setEphemeralCommands(instancesDir, CHANNEL, false);
  clearUserPreferences(instancesDir, CHANNEL);
  expect(readEphemeralCommands(instancesDir, CHANNEL)).toBe(true);
});

it("setEphemeralCommands returns false when the write fails", () => {
  fs.writeFileSync(path.join(instancesDir, "shared"), "not a directory");
  expect(setEphemeralCommands(instancesDir, CHANNEL, false)).toBe(false);
});
