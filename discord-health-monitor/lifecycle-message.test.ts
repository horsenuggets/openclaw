import { describe, expect, it } from "vitest";
import {
  buildLifecycleInfo,
  buildLifecycleMessage,
  formatBytes,
  formatDuration,
  LIFECYCLE_LEAD,
  type LifecycleInput,
} from "./lifecycle-message.js";

const BASE: LifecycleInput = {
  event: "startup",
  reason: "ROUTER_RESTART",
  pid: 4321,
  uptimeSeconds: 3723,
  lastHealthyAt: Date.parse("2026-10-05T00:00:00.000Z"),
  now: Date.parse("2026-10-05T00:00:12.000Z"),
  discordApiPingMs: 83,
  memory: { rss: 89_214_976, heapUsed: 23_170_000 },
};

describe("formatBytes", () => {
  it("scales into the largest fitting unit", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2 KB");
    expect(formatBytes(89_214_976)).toBe("85.1 MB");
    expect(formatBytes(3 * 1024 * 1024 * 1024)).toBe("3 GB");
  });

  it("never renders a negative size", () => {
    expect(formatBytes(-10)).toBe("0 B");
  });
});

describe("formatDuration", () => {
  it("renders hours, minutes, and seconds, dropping zero leading units", () => {
    expect(formatDuration(3723)).toBe("1h 2m 3s");
    expect(formatDuration(62)).toBe("1m 2s");
    expect(formatDuration(45)).toBe("45s");
  });

  it("renders 0s for sub-second and non-positive inputs", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(0.4)).toBe("0s");
    expect(formatDuration(-5)).toBe("0s");
  });

  it("omits seconds when a larger unit lands on a boundary", () => {
    expect(formatDuration(3600)).toBe("1h");
    expect(formatDuration(120)).toBe("2m");
  });
});

describe("buildLifecycleInfo", () => {
  it("reports reason, pid, downtime, ping, and memory on a router restart", () => {
    const info = buildLifecycleInfo(BASE);
    expect(info).toEqual({
      reason: "ROUTER_RESTART",
      pid: 4321,
      downtime: "12s",
      discordApiPing: "83ms",
      memory: { rss: "85.1 MB", heapUsed: "22.1 MB" },
    });
  });

  it("reports downtime as null on the initial boot (no prior health)", () => {
    const info = buildLifecycleInfo({ ...BASE, reason: "INITIAL_BOOT", lastHealthyAt: null });
    expect(info).toEqual({
      reason: "INITIAL_BOOT",
      pid: 4321,
      downtime: null,
      discordApiPing: "83ms",
      memory: { rss: "85.1 MB", heapUsed: "22.1 MB" },
    });
    expect(info).not.toHaveProperty("uptime");
  });

  it("reports reason, pid, uptime, ping, and memory on shutdown (no downtime)", () => {
    const info = buildLifecycleInfo({ ...BASE, event: "shutdown", reason: "SIGTERM" });
    expect(info).toEqual({
      reason: "SIGTERM",
      pid: 4321,
      uptime: "1h 2m 3s",
      discordApiPing: "83ms",
      memory: { rss: "85.1 MB", heapUsed: "22.1 MB" },
    });
    expect(info).not.toHaveProperty("downtime");
  });

  it("omits pid when it is not known", () => {
    const info = buildLifecycleInfo({ ...BASE, pid: null });
    expect(info).not.toHaveProperty("pid");
  });

  it("omits discordApiPing when the probe failed (null)", () => {
    const info = buildLifecycleInfo({ ...BASE, discordApiPingMs: null });
    expect(info).not.toHaveProperty("discordApiPing");
  });
});

describe("buildLifecycleMessage", () => {
  it("leads with the event phrase followed by a parseable JSON payload", () => {
    const message = buildLifecycleMessage(BASE);
    expect(message.startsWith(`${LIFECYCLE_LEAD.startup} `)).toBe(true);
    const json = message.slice(LIFECYCLE_LEAD.startup.length + 1);
    expect(JSON.parse(json)).toEqual(buildLifecycleInfo(BASE));
  });

  it("uses the shutdown lead phrase for a shutdown event", () => {
    const message = buildLifecycleMessage({ ...BASE, event: "shutdown", reason: "SIGINT" });
    expect(message.startsWith(`${LIFECYCLE_LEAD.shutdown} `)).toBe(true);
  });
});
