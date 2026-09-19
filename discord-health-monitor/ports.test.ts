import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readInstancePort } from "./ports.js";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "health-port-dotfile-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("readInstancePort", () => {
  it("reads a positive integer from the .port file", () => {
    fs.writeFileSync(path.join(dir, ".port"), "18789\n");
    expect(readInstancePort(dir)).toBe(18789);
  });

  it("returns undefined for missing, invalid, or non-positive ports", () => {
    expect(readInstancePort(dir)).toBeUndefined();

    for (const bad of ["0", "-1", "+18789", "18789junk", "18789.5", "١٨٧٨٩"]) {
      fs.writeFileSync(path.join(dir, ".port"), bad);
      expect(readInstancePort(dir)).toBeUndefined();
    }
  });

  it("canonicalizes leading-zero decimal ports", () => {
    fs.writeFileSync(path.join(dir, ".port"), "018789");
    expect(readInstancePort(dir)).toBe(18789);
  });
});
