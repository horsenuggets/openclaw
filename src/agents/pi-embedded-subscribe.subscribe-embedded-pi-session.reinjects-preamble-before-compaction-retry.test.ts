import { describe, expect, it, vi } from "vitest";
import { subscribeEmbeddedPiSession } from "./pi-embedded-subscribe.js";

describe("subscribeEmbeddedPiSession", () => {
  it("re-injects the persona preamble before an auto-compaction retry", () => {
    const listeners: Array<(evt: unknown) => void> = [];
    const session = {
      subscribe: (listener: (evt: unknown) => void) => {
        listeners.push(listener);
        return () => {};
      },
    } as unknown as Parameters<typeof subscribeEmbeddedPiSession>[0]["session"];

    const onBeforeCompactionRetry = vi.fn();
    subscribeEmbeddedPiSession({ session, runId: "run-reinject", onBeforeCompactionRetry });

    // A compaction that will NOT retry must not re-inject (no retry is coming).
    for (const listener of listeners) {
      listener({ type: "auto_compaction_end", willRetry: false });
    }
    expect(onBeforeCompactionRetry).not.toHaveBeenCalled();

    // A compaction that WILL retry must re-inject before the retry proceeds, so the
    // rebuilt (persisted) message list regains the never-persisted preamble.
    for (const listener of listeners) {
      listener({ type: "auto_compaction_end", willRetry: true });
    }
    expect(onBeforeCompactionRetry).toHaveBeenCalledTimes(1);
  });
});
