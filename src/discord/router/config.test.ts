import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadRouterConfig, readInstancePort, resolveProxyBindHost } from "./config.js";

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
    for (const bad of ["18789junk", "18789.5", "18789 18790", "١٨٧٨٩"]) {
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

describe("resolveProxyBindHost", () => {
  it("defaults to loopback when unset, empty, or whitespace", () => {
    expect(resolveProxyBindHost(undefined)).toBe("127.0.0.1");
    expect(resolveProxyBindHost("")).toBe("127.0.0.1");
    expect(resolveProxyBindHost("   ")).toBe("127.0.0.1");
  });

  it("accepts loopback and RFC1918 private addresses, trimming whitespace", () => {
    expect(resolveProxyBindHost("127.0.0.1")).toBe("127.0.0.1");
    expect(resolveProxyBindHost("::1")).toBe("::1");
    // The agent bridge gateway lives in 172.16/12.
    expect(resolveProxyBindHost(" 172.30.0.1 ")).toBe("172.30.0.1");
    expect(resolveProxyBindHost("10.1.2.3")).toBe("10.1.2.3");
    expect(resolveProxyBindHost("192.168.4.5")).toBe("192.168.4.5");
  });

  it("rejects wildcard binds so the credential-bearing proxies stay private", () => {
    expect(() => resolveProxyBindHost("0.0.0.0")).toThrow(/not allowed/);
    expect(() => resolveProxyBindHost("::")).toThrow(/not allowed/);
  });

  it("rejects public addresses and malformed input", () => {
    expect(() => resolveProxyBindHost("8.8.8.8")).toThrow(/not allowed/);
    expect(() => resolveProxyBindHost("172.32.0.1")).toThrow(/not allowed/); // just outside 172.16/12
    expect(() => resolveProxyBindHost("172.15.0.1")).toThrow(/not allowed/); // just below 172.16/12
    expect(() => resolveProxyBindHost("300.1.2.3")).toThrow(/not allowed/);
    expect(() => resolveProxyBindHost("not-an-ip")).toThrow(/not allowed/);
  });
});
