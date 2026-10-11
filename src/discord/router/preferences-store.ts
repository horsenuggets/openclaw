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
  try {
    return asPreferences(
      JSON.parse(fs.readFileSync(userPreferencesPath(instancesDir, channelId), "utf-8")),
    );
  } catch {
    // New store absent/unreadable: fall back to the legacy .onboarding.json block.
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
 * Reset a channel's preferences to defaults, e.g. on unregister. Writes an empty
 * tombstone rather than deleting the file: a plain delete would re-expose the
 * legacy `.onboarding.json` fallback in {@link readUserPreferences}, so a channel
 * an older release left lifecycle-enabled would resurrect that setting when it is
 * re-registered (the provisioner preserves the instance dir and its
 * `.onboarding.json`). The empty file suppresses the fallback so a re-registered
 * channel starts from defaults. Throws on a genuine write failure so the caller
 * can log it rather than clearing silently.
 */
export function clearUserPreferences(instancesDir: string, channelId: string): void {
  writeUserPreferences(instancesDir, channelId, {});
}
