import fs from "node:fs";
import path from "node:path";

/**
 * Per-channel user preferences, owned and written by the router (unlike the
 * provisioner-owned `.onboarding.json`, which holds registration facts such as
 * `ownerId`/`isDM`). Kept in a separate, router-writable location so the router
 * can persist them even when the rest of the instances tree is mounted read-only
 * (see infrastructure/docker/discord-router.yml).
 */
export type UserPreferences = {
  /** Show agent startup/shutdown lifecycle banners. Default: false. */
  lifecycleMessages?: boolean;
  /**
   * Whether this channel's slash-command replies are ephemeral (visible only to
   * the caller). Default: true. Turning it off (e.g. via `/debug ephemeral off`)
   * makes command results persist in-channel so they can be inspected during
   * testing, where ephemeral replies otherwise vanish and cannot be verified.
   */
  ephemeralCommands?: boolean;
};

/**
 * Where a channel's preferences file lives: a writable subtree alongside the
 * instance directories, mirroring the `shared/auth` carve-out. Both the router
 * and the health-monitor resolve the path through this helper so they never
 * disagree on the location.
 */
export function userPreferencesPath(instancesDir: string, channelId: string): string {
  return path.join(instancesDir, "shared", "preferences", `${channelId}.json`);
}

function asPreferences(raw: unknown): UserPreferences {
  return raw != null && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as UserPreferences)
    : {};
}

/**
 * Read a channel's preferences, or `{}` when none are stored or the file is
 * unreadable. Falls back to the legacy location (`<channelId>/.onboarding.json`'s
 * `preferences` block) when the new file is absent, so a preference that an older
 * release persisted there on a writable deployment is not lost on upgrade. The
 * next {@link writeUserPreferences} migrates it forward to the new store.
 */
export function readUserPreferences(instancesDir: string, channelId: string): UserPreferences {
  // Fall back to the legacy block ONLY when the new store is absent. A present but
  // malformed/unreadable new-store file (including an empty tombstone that got
  // corrupted) reads as defaults and must NOT re-expose the legacy block, or a
  // cleared channel could resurrect a stale legacy lifecycle setting.
  const file = userPreferencesPath(instancesDir, channelId);
  if (fs.existsSync(file)) {
    try {
      return asPreferences(JSON.parse(fs.readFileSync(file, "utf-8")));
    } catch {
      return {};
    }
  }
  try {
    const legacy = JSON.parse(
      fs.readFileSync(path.join(instancesDir, channelId, ".onboarding.json"), "utf-8"),
    );
    return asPreferences(legacy?.preferences);
  } catch {
    return {};
  }
}

/**
 * Persist a channel's preferences, creating the writable subtree if needed.
 * Throws on a genuine write failure (e.g. a read-only mount) so the caller can
 * surface it rather than silently reporting success.
 */
export function writeUserPreferences(
  instancesDir: string,
  channelId: string,
  preferences: UserPreferences,
): void {
  const file = userPreferencesPath(instancesDir, channelId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Write + rename so a crashed/partial write can never leave a truncated file a
  // reader would treat as "{}", silently dropping a live preference.
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(preferences, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

/**
 * Reset a channel's preferences to defaults by writing an empty tombstone rather
 * than deleting the file: a plain delete would re-expose the legacy
 * `.onboarding.json` fallback in {@link readUserPreferences}, so a channel an
 * older release left lifecycle-enabled would resurrect that setting. Use this when
 * the instance directory (and its legacy `.onboarding.json`) is PRESERVED. Throws
 * on a genuine write failure so the caller can log it rather than clearing
 * silently. For a destructive teardown that wipes the instance dir, prefer
 * {@link removeUserPreferences}, which leaves no metadata behind.
 */
export function clearUserPreferences(instancesDir: string, channelId: string): void {
  writeUserPreferences(instancesDir, channelId, {});
}

/**
 * Hard-delete a channel's preferences file, leaving no metadata behind. Safe only
 * for a DESTRUCTIVE teardown (`purge`/`/channel unregister`) that already wiped
 * the instance directory, so the legacy `.onboarding.json` fallback source is gone
 * too and a plain delete cannot resurrect a stale setting. Idempotent: a missing
 * file is fine. Unlike {@link clearUserPreferences} it does not leave an empty
 * tombstone, so the promised "all data removed" wipe really removes everything.
 * Also removes the `.tmp` write-temp {@link writeUserPreferences} uses, which a
 * crash between write and rename can orphan, so no per-channel metadata survives.
 */
export function removeUserPreferences(instancesDir: string, channelId: string): void {
  const file = userPreferencesPath(instancesDir, channelId);
  fs.rmSync(file, { force: true });
  fs.rmSync(`${file}.tmp`, { force: true });
}

/**
 * Whether a channel's slash-command replies should be ephemeral. Defaults to
 * true (ephemeral) when unset, so commands stay private unless a tester opts the
 * channel out via `/debug ephemeral off`. Read channel-keyed (not from an
 * in-memory instance) because `/debug` runs on any channel, including ones with
 * no registered instance.
 *
 * Fails CLOSED (private): only an explicit `false` makes replies public. The
 * preferences file is arbitrary JSON cast to UserPreferences, so a malformed
 * value (e.g. `0`, `""`, or a string "false") must not be allowed to flip a
 * channel public and leak a reply; anything that is not literally `false` is
 * treated as the private default.
 */
export function readEphemeralCommands(instancesDir: string, channelId: string): boolean {
  return readUserPreferences(instancesDir, channelId).ephemeralCommands !== false;
}

/**
 * Persist a channel's ephemeral-command preference, preserving any other stored
 * preferences. Returns whether the write succeeded so the caller can surface a
 * failure (e.g. a read-only mount) rather than reporting a change that did not
 * stick.
 */
export function setEphemeralCommands(
  instancesDir: string,
  channelId: string,
  value: boolean,
): boolean {
  try {
    const prefs: UserPreferences = { ...readUserPreferences(instancesDir, channelId) };
    prefs.ephemeralCommands = value;
    writeUserPreferences(instancesDir, channelId, prefs);
    return true;
  } catch {
    return false;
  }
}
