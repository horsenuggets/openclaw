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
  fs.writeFileSync(file, `${JSON.stringify(preferences, null, 2)}\n`);
}

/** Remove a channel's preferences file (no-op when absent), e.g. on unregister. */
export function deleteUserPreferences(instancesDir: string, channelId: string): void {
  try {
    fs.rmSync(userPreferencesPath(instancesDir, channelId));
  } catch {
    // Nothing stored for this channel; deletion is a no-op.
  }
}
