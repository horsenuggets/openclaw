import { describe, expect, it, vi } from "vitest";

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
import { classifyMessageTopic, startJobClassification } from "./job-classifier.js";

const mockedRun = vi.mocked(runCommandWithTimeout);

function cliJsonResult(text: string) {
  return { code: 0, stdout: JSON.stringify({ result: text }), stderr: "" };
}

const baseCfg = {} as Parameters<typeof classifyMessageTopic>[0]["cfg"];

describe("classifyMessageTopic", () => {
  it("returns NEW when no previous job summary", async () => {
    const result = await classifyMessageTopic({
      message: "hello",
      cfg: baseCfg,
    });
    expect(result).toEqual({ decision: "NEW", reason: "no active job" });
    expect(mockedRun).not.toHaveBeenCalled();
  });

  it("parses NEW: prefix from CLI response", async () => {
    mockedRun.mockResolvedValue(cliJsonResult("NEW: different topic"));
    const result = await classifyMessageTopic({
      message: "what is the weather?",
      previousJobSummary: "User asked about code refactoring",
      cfg: baseCfg,
    });
    expect(result).toEqual({ decision: "NEW", reason: "different topic" });
  });

  it("parses CONTINUE: prefix from CLI response", async () => {
    mockedRun.mockResolvedValue(cliJsonResult("CONTINUE: same topic"));
    const result = await classifyMessageTopic({
      message: "and also add tests",
      previousJobSummary: "User asked to write a function",
      cfg: baseCfg,
    });
    expect(result).toEqual({ decision: "CONTINUE", reason: "same topic" });
  });

  it("parses NEW: without space after colon", async () => {
    mockedRun.mockResolvedValue(cliJsonResult("NEW:no space"));
    const result = await classifyMessageTopic({
      message: "hi",
      previousJobSummary: "something",
      cfg: baseCfg,
    });
    expect(result).toEqual({ decision: "NEW", reason: "no space" });
  });

  it("parses CONTINUE: without space after colon", async () => {
    mockedRun.mockResolvedValue(cliJsonResult("CONTINUE:still same topic"));
    const result = await classifyMessageTopic({
      message: "and this too",
      previousJobSummary: "something",
      cfg: baseCfg,
    });
    expect(result).toEqual({ decision: "CONTINUE", reason: "still same topic" });
  });

  it("defaults to NEW for unrecognized response", async () => {
    mockedRun.mockResolvedValue(cliJsonResult("I'm not sure what to do"));
    const result = await classifyMessageTopic({
      message: "test",
      previousJobSummary: "something",
      cfg: baseCfg,
    });
    expect(result.decision).toBe("NEW");
  });

  it("defaults to NEW on CLI failure", async () => {
    mockedRun.mockResolvedValue({ code: 1, stdout: "", stderr: "error" });
    const result = await classifyMessageTopic({
      message: "test",
      previousJobSummary: "something",
      cfg: baseCfg,
    });
    expect(result).toEqual({ decision: "NEW", reason: "default" });
  });

  it("defaults to NEW when aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await classifyMessageTopic({
      message: "test",
      previousJobSummary: "something",
      cfg: baseCfg,
      signal: controller.signal,
    });
    expect(result).toEqual({ decision: "NEW", reason: "default" });
  });

  it("defaults to NEW on timeout/error", async () => {
    mockedRun.mockRejectedValue(new Error("timeout"));
    const result = await classifyMessageTopic({
      message: "test",
      previousJobSummary: "something",
      cfg: baseCfg,
    });
    expect(result).toEqual({ decision: "NEW", reason: "default" });
  });
});

describe("startJobClassification", () => {
  it("returns controller that resolves with classification", async () => {
    mockedRun.mockResolvedValue(cliJsonResult("NEW: greeting"));
    const controller = startJobClassification({
      message: "hi",
      previousJobSummary: "old topic",
      cfg: baseCfg,
    });
    const result = await controller.result;
    expect(result.decision).toBe("NEW");
  });

  it("returns NEW when cancelled", async () => {
    mockedRun.mockImplementation(
      () =>
        new Promise((resolve) => setTimeout(() => resolve(cliJsonResult("CONTINUE: same")), 100)),
    );
    const controller = startJobClassification({
      message: "test",
      previousJobSummary: "something",
      cfg: baseCfg,
    });
    controller.cancel();
    const result = await controller.result;
    expect(result.decision).toBe("NEW");
    expect(result.reason).toBe("cancelled");
  });
});
