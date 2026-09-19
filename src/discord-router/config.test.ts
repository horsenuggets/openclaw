import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadRouterConfig, readInstancePort } from "./config.js";

let dir: string;

function makeInstance(channelId: string, opts: { port?: string; token?: string } = {}): void {
  const instanceDir = path.join(dir, channelId);
  fs.mkdirSync(instanceDir, { recursive: true });
  if (opts.port !== undefined) {
    fs.writeFileSync(path.join(instanceDir, ".port"), opts.port);
  }
  fs.writeFileSync(
    path.join(instanceDir, "openclaw.json"),
    JSON.stringify({ gateway: { auth: { token: opts.token ?? `tok-${channelId}` } } }),
  );
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "port-dotfile-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.OPENCLAW_1468768406504476936_PORT;
});

describe("readInstancePort", () => {
  it("reads a positive integer from the .port file", () => {
    const d = path.join(dir, "1468768406504476936");
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, ".port"), "18789\n");
    expect(readInstancePort(d)).toBe(18789);
  });

  it("returns undefined when the file is missing", () => {
    const d = path.join(dir, "1468768406504476936");
    fs.mkdirSync(d, { recursive: true });
    expect(readInstancePort(d)).toBeUndefined();
  });

  it("returns undefined for non-numeric or non-positive contents", () => {
    const d = path.join(dir, "1468768406504476936");
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, ".port"), "nope");
    expect(readInstancePort(d)).toBeUndefined();
    fs.writeFileSync(path.join(d, ".port"), "0");
    expect(readInstancePort(d)).toBeUndefined();
  });

  it("rejects a value with a valid numeric prefix but trailing junk", () => {
    const d = path.join(dir, "1468768406504476936");
    fs.mkdirSync(d, { recursive: true });
    // parseInt would accept these; boot/list use strict int() and skip them,
    // so the router must reject them too to stay consistent.
    for (const bad of ["18789junk", "18789.5", "18789 18790"]) {
      fs.writeFileSync(path.join(d, ".port"), bad);
      expect(readInstancePort(d)).toBeUndefined();
    }
  });
});

describe("loadRouterConfig", () => {
  it("routes only instances that have a valid .port dotfile", () => {
    makeInstance("1468768406504476936", { port: "18789" });
    makeInstance("1495182622433873982", { port: "18790" });
    makeInstance("1495193224925679796"); // no .port → skipped

    const config = loadRouterConfig({ instancesDir: dir, discordToken: "bot-token" });

    expect([...config.instances.keys()].toSorted()).toEqual([
      "1468768406504476936",
      "1495182622433873982",
    ]);
    expect(config.instances.get("1468768406504476936")?.port).toBe(18789);
    expect(config.instances.get("1495182622433873982")?.port).toBe(18790);
  });

  it("lets OPENCLAW_<channelId>_PORT override the dotfile", () => {
    makeInstance("1468768406504476936", { port: "18789" });
    process.env.OPENCLAW_1468768406504476936_PORT = "19999";

    const config = loadRouterConfig({ instancesDir: dir, discordToken: "bot-token" });

    expect(config.instances.get("1468768406504476936")?.port).toBe(19999);
  });

  it("ignores non-channel directories", () => {
    makeInstance("1468768406504476936", { port: "18789" });
    fs.mkdirSync(path.join(dir, "shared"), { recursive: true });
    fs.writeFileSync(path.join(dir, "shared", ".port"), "18800");

    const config = loadRouterConfig({ instancesDir: dir, discordToken: "bot-token" });

    expect([...config.instances.keys()]).toEqual(["1468768406504476936"]);
  });
});
