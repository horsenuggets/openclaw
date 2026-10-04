import path from "node:path";
import { describe, expect, it } from "vitest";
import { readEmbedAsset, resolveEmbedAssetsDir } from "./embed-assets.js";

/** PNG files start with this 8-byte signature. */
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe("resolveEmbedAssetsDir", () => {
  it("resolves the assets/embeds directory", () => {
    const dir = resolveEmbedAssetsDir();
    expect(dir).not.toBeNull();
    expect(dir!.endsWith(path.join("assets", "embeds"))).toBe(true);
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
