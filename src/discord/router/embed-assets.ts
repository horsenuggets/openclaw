import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Locate and read the embed icon files shipped in `assets/embeds`.
 *
 * The router sends category icons (footer icons, thumbnails) by uploading the
 * PNG bytes with the message, so it needs to read them from disk at runtime.
 * The lookup must work across every way the router runs:
 *
 * > Production: a bun-compiled standalone binary in a bare `ubuntu:24.04`
 * >   container. There is no repo tree to walk, so deploy mounts the icons and
 * >   points `OPENCLAW_EMBED_ASSETS_DIR` at the mount; a run of the bare binary
 * >   also finds icons sitting next to `process.execPath`.
 * > Dev / npm: `assets/embeds` lives in the repo / installed package, found by
 * >   walking up from this module.
 */

/** Directories to probe relative to a base, in order. */
const RELATIVE_CANDIDATES = [path.join("assets", "embeds"), "embeds"];

let cachedDir: string | null | undefined;

/** Test hook: drop the memoized directory so a changed env is picked up. */
export function resetEmbedAssetsDirCache(): void {
  cachedDir = undefined;
}

function firstExisting(base: string): string | null {
  for (const rel of RELATIVE_CANDIDATES) {
    const candidate = path.join(base, rel);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

/** Resolve the absolute embed-assets directory, or null if not found. */
export function resolveEmbedAssetsDir(): string | null {
  if (cachedDir !== undefined) {
    return cachedDir;
  }
  // 1. Explicit override (set by the production compose for the compiled binary).
  const override = process.env.OPENCLAW_EMBED_ASSETS_DIR;
  if (override && fs.existsSync(override)) {
    cachedDir = override;
    return override;
  }
  // 2. Next to the executable (a standalone binary run with icons alongside it).
  const nearExe = firstExisting(path.dirname(process.execPath));
  if (nearExe) {
    cachedDir = nearExe;
    return nearExe;
  }
  // 3. Walk up from this module (dev source tree / installed npm package).
  let current = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i++) {
    const found = firstExisting(current);
    if (found) {
      cachedDir = found;
      return found;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  cachedDir = null;
  return null;
}

/** Read an embed icon's bytes by filename, or null if it cannot be read. */
export function readEmbedAsset(filename: string): Buffer | null {
  const dir = resolveEmbedAssetsDir();
  if (!dir) {
    return null;
  }
  try {
    // basename guards against path traversal: only files directly in the dir.
    return fs.readFileSync(path.join(dir, path.basename(filename)));
  } catch {
    return null;
  }
}
