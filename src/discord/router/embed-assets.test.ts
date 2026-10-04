import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readEmbedAsset, resetEmbedAssetsDirCache, resolveEmbedAssetsDir } from "./embed-assets.js";

/** PNG files start with this 8-byte signature. */
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe("resolveEmbedAssetsDir", () => {
  afterEach(() => {
    delete process.env.OPENCLAW_EMBED_ASSETS_DIR;
    resetEmbedAssetsDirCache();
  });

  it("resolves the assets/embeds directory", () => {
    resetEmbedAssetsDirCache();
    const dir = resolveEmbedAssetsDir();
    expect(dir).not.toBeNull();
    expect(dir!.endsWith(path.join("assets", "embeds"))).toBe(true);
  });

  it("prefers the OPENCLAW_EMBED_ASSETS_DIR override (the production mount)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "embed-override-"));
    try {
      fs.writeFileSync(path.join(tmp, "general.png"), "stub");
      process.env.OPENCLAW_EMBED_ASSETS_DIR = tmp;
      resetEmbedAssetsDirCache();
      expect(resolveEmbedAssetsDir()).toBe(tmp);
      expect(readEmbedAsset("general.png")?.toString()).toBe("stub");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("readEmbedAsset", () => {
  it("reads a known icon as PNG bytes", () => {
    const data = readEmbedAsset("general.png");
    expect(data).not.toBeNull();
    expect(data!.subarray(0, 8)).toEqual(PNG_MAGIC);
  });

  it("returns null for a missing icon", () => {
    expect(readEmbedAsset("does-not-exist.png")).toBeNull();
  });

  it("guards against path traversal by reducing to a basename", () => {
    // `../package.json` collapses to `package.json`, which is not inside
    // assets/embeds, so it cannot be read (no escaping the directory).
    expect(readEmbedAsset("../package.json")).toBeNull();
    expect(readEmbedAsset("../../package.json")).toBeNull();
  });
});
