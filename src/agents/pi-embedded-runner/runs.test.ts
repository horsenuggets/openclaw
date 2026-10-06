import { describe, expect, it, vi } from "vitest";
import type { EmbeddedPiQueueMode } from "./runs.js";
import { clearActiveEmbeddedRun, queueEmbeddedPiMessage, setActiveEmbeddedRun } from "./runs.js";

function fakeHandle(overrides: Partial<ReturnType<typeof baseHandle>> = {}) {
  return { ...baseHandle(), ...overrides };
}
function baseHandle() {
  return {
    queueMessage: vi.fn<(text: string, mode: EmbeddedPiQueueMode) => Promise<void>>(async () => {}),
    isStreaming: () => true,
    isCompacting: () => false,
    abort: () => {},
  };
}

describe("queueEmbeddedPiMessage injection mode", () => {
  it("defaults to followup", () => {
    const handle = fakeHandle();
    setActiveEmbeddedRun("s1", handle);
    expect(queueEmbeddedPiMessage("s1", "hello")).toBe(true);
    expect(handle.queueMessage).toHaveBeenCalledWith("hello", "followup");
    clearActiveEmbeddedRun("s1", handle);
  });

  it("forwards steer mode so the run reacts at the next tool boundary", () => {
    const handle = fakeHandle();
    setActiveEmbeddedRun("s2", handle);
    expect(queueEmbeddedPiMessage("s2", "handle this now", "steer")).toBe(true);
    expect(handle.queueMessage).toHaveBeenCalledWith("handle this now", "steer");
    clearActiveEmbeddedRun("s2", handle);
  });

  it("does not inject (returns false) when the run is not streaming", () => {
    const handle = fakeHandle({ isStreaming: () => false });
    setActiveEmbeddedRun("s3", handle);
    expect(queueEmbeddedPiMessage("s3", "x", "steer")).toBe(false);
    expect(handle.queueMessage).not.toHaveBeenCalled();
    clearActiveEmbeddedRun("s3", handle);
  });

  it("does not inject while the run is compacting", () => {
    const handle = fakeHandle({ isCompacting: () => true });
    setActiveEmbeddedRun("s4", handle);
    expect(queueEmbeddedPiMessage("s4", "x", "steer")).toBe(false);
    expect(handle.queueMessage).not.toHaveBeenCalled();
    clearActiveEmbeddedRun("s4", handle);
  });

  it("returns false when there is no active run", () => {
    expect(queueEmbeddedPiMessage("missing", "x", "steer")).toBe(false);
  });
});
