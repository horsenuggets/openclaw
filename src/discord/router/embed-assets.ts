import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Locate and read the embed icon files shipped in `assets/embeds`.
 *
 * The router sends category icons (footer icons, thumbnails) by uploading the
 * PNG bytes with the message, so it needs to read them from disk at runtime.
 * They live in `assets/embeds`, which ships both ways: `assets/` is in
 * package.json's `files` (npm installs) and the Docker image copies the whole
 * repo. The directory is found by walking up from this module until a sibling
 * `assets/embeds` exists, which works from `src` (dev), bundled `dist`, and a
 * globally installed package alike.
 */

let cachedDir: string | null | undefined;

/** Resolve the absolute `assets/embeds` directory, or null if not found. */
export function resolveEmbedAssetsDir(): string | null {
  if (cachedDir !== undefined) {
    return cachedDir;
  }
  let current = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i++) {
    const candidate = path.join(current, "assets", "embeds");
    if (fs.existsSync(candidate)) {
      cachedDir = candidate;
      return candidate;
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
