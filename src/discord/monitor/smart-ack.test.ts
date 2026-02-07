import { describe, expect, it, vi } from "vitest";

// Mock dependencies before importing the module under test
vi.mock("../../globals.js", () => ({
  logVerbose: vi.fn(),
  shouldLogVerbose: () => false,
}));

vi.mock("../../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock("../../process/exec.js", () => ({
  runCommandWithTimeout: vi.fn(),
}));

import { runCommandWithTimeout } from "../../process/exec.js";
import { generateSmartAck } from "./smart-ack.js";

const mockedRun = vi.mocked(runCommandWithTimeout);

function cliJsonResult(text: string) {
  return { code: 0, stdout: JSON.stringify({ result: text }), stderr: "" };
}

const baseCfg = {} as Parameters<typeof generateSmartAck>[0]["cfg"];

describe("generateSmartAck prefix parsing", () => {
  it("strips FULL: prefix and returns isFull=true", async () => {
    mockedRun.mockResolvedValue(cliJsonResult("FULL: Hello there!"));
    const result = await generateSmartAck({ message: "hi", cfg: baseCfg });
    expect(result).toEqual({ text: "Hello there!", isFull: true });
  });

  it("strips ACK: prefix and returns isFull=false", async () => {
    mockedRun.mockResolvedValue(cliJsonResult("ACK: Working on that..."));
    const result = await generateSmartAck({ message: "explain quantum physics", cfg: baseCfg });
    expect(result).toEqual({ text: "Working on that...", isFull: false });
  });

  it("strips SIMPLE: prefix and treats as isFull=true", async () => {
    mockedRun.mockResolvedValue(cliJsonResult("SIMPLE: The memory is located at ~/.claude/"));
    const result = await generateSmartAck({ message: "where is the memory?", cfg: baseCfg });
    expect(result).toEqual({ text: "The memory is located at ~/.claude/", isFull: true });
  });

  it("strips FULL: prefix without space after colon", async () => {
    mockedRun.mockResolvedValue(cliJsonResult("FULL:No space here"));
    const result = await generateSmartAck({ message: "hi", cfg: baseCfg });
    expect(result).toEqual({ text: "No space here", isFull: true });
  });

  it("strips SIMPLE: prefix without space after colon", async () => {
    mockedRun.mockResolvedValue(cliJsonResult("SIMPLE:No space here either"));
    const result = await generateSmartAck({ message: "hi", cfg: baseCfg });
    expect(result).toEqual({ text: "No space here either", isFull: true });
  });

  it("passes through response with no recognized prefix", async () => {
    mockedRun.mockResolvedValue(cliJsonResult("Just a plain response"));
    const result = await generateSmartAck({ message: "hi", cfg: baseCfg });
    expect(result).toEqual({ text: "Just a plain response", isFull: false });
  });

  it("returns null for empty response after prefix strip", async () => {
    mockedRun.mockResolvedValue(cliJsonResult("FULL:   "));
    const result = await generateSmartAck({ message: "hi", cfg: baseCfg });
    expect(result).toBeNull();
  });

  it("returns null when CLI fails", async () => {
    mockedRun.mockResolvedValue({ code: 1, stdout: "", stderr: "error" });
    const result = await generateSmartAck({ message: "hi", cfg: baseCfg });
    expect(result).toBeNull();
  });

  it("returns null when aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await generateSmartAck({
      message: "hi",
      cfg: baseCfg,
      signal: controller.signal,
    });
    expect(result).toBeNull();
  });
});
