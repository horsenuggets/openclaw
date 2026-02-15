import { describe, expect, it, vi } from "vitest";
import { createSmartStatus } from "./smart-status.js";

describe("createSmartStatus", () => {
  it("does not emit status on tool_start (result blocks handle it)", () => {
    const updates: string[] = [];
    const status = createSmartStatus({
      userMessage: "What's on my calendar?",
      onUpdate: (text) => updates.push(text),
      config: { minIntervalMs: 0 },
    });

    status.push({
      type: "tool_start",
      toolName: "Bash",
      toolCallId: "c1",
      input: { command: "gog calendar events --today" },
    });
    status.push({
      type: "tool_start",
      toolName: "Read",
      toolCallId: "c2",
      input: { file_path: "/home/user/docs/readme.md" },
    });
    status.dispose();

    expect(updates.length).toBe(0);
  });

  it("emits thinking excerpts with prefix", () => {
    const updates: string[] = [];
    const status = createSmartStatus({
      userMessage: "Find files",
      onUpdate: (text) => updates.push(text),
      config: { minIntervalMs: 0 },
    });

    status.push({
      type: "thinking",
      text: "Let me check the calendar events for today",
    });
    status.dispose();

    expect(updates.length).toBe(1);
    expect(updates[0]).toMatch(/^\*/);
    expect(updates[0]).toContain("check the calendar");
  });

  it("truncates long thinking excerpts", () => {
    const updates: string[] = [];
    const status = createSmartStatus({
      userMessage: "test",
      onUpdate: (text) => updates.push(text),
      config: { minIntervalMs: 0, maxStatusLength: 30 },
    });

    const longThinking = "A".repeat(100);
    status.push({ type: "thinking", text: longThinking });
    status.dispose();

    expect(updates.length).toBe(1);
    expect(updates[0]).toContain("...");
    expect(updates[0].length).toBeLessThanOrEqual(40);
  });

  it("does not emit for text or tool_result events", () => {
    const updates: string[] = [];
    const status = createSmartStatus({
      userMessage: "test",
      onUpdate: (text) => updates.push(text),
      config: { minIntervalMs: 0 },
    });

    status.push({ type: "text", text: "Here is my response" });
    status.push({ type: "tool_result", toolCallId: "c1", toolName: "Bash", isError: false });
    status.dispose();

    expect(updates.length).toBe(0);
  });

  it("debounces rapid thinking updates", async () => {
    vi.useFakeTimers();
    const updates: string[] = [];
    const status = createSmartStatus({
      userMessage: "test",
      onUpdate: (text) => updates.push(text),
      config: { minIntervalMs: 3000 },
    });

    // First thinking event fires immediately.
    status.push({ type: "thinking", text: "Let me check the calendar" });
    expect(updates.length).toBe(1);

    // Second thinking event within window is debounced.
    status.push({ type: "thinking", text: "Now looking at the events" });
    expect(updates.length).toBe(1);

    // After interval elapses, debounced event fires.
    vi.advanceTimersByTime(3000);
    expect(updates.length).toBe(2);

    status.dispose();
    vi.useRealTimers();
  });

  it("suppresses updates during suppression window", () => {
    const updates: string[] = [];
    const status = createSmartStatus({
      userMessage: "test",
      onUpdate: (text) => updates.push(text),
      config: { minIntervalMs: 0 },
    });

    status.suppress(5000);
    status.push({ type: "thinking", text: "Processing the request" });

    expect(updates.length).toBe(0);
    status.dispose();
  });

  it("does not emit duplicate status text", () => {
    const updates: string[] = [];
    const status = createSmartStatus({
      userMessage: "test",
      onUpdate: (text) => updates.push(text),
      config: { minIntervalMs: 0 },
    });

    // Same thinking text twice should only emit once.
    status.push({ type: "thinking", text: "Processing" });
    status.push({ type: "thinking", text: "Processing" });
    status.dispose();

    expect(updates.length).toBe(1);
  });

  it("handles multiple thinking excerpts in sequence", () => {
    const updates: string[] = [];
    const status = createSmartStatus({
      userMessage: "test",
      onUpdate: (text) => updates.push(text),
      config: { minIntervalMs: 0 },
    });

    status.push({ type: "thinking", text: "Checking the calendar" });
    status.push({ type: "thinking", text: "Found the events" });
    status.dispose();

    expect(updates.length).toBe(2);
    expect(updates[0]).toContain("Checking the calendar");
    expect(updates[1]).toContain("Found the events");
  });
});
