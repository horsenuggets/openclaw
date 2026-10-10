import { describe, expect, it } from "vitest";
import { remainingDebounceMs } from "./create_new_thread.js";

describe("remainingDebounceMs", () => {
  it("returns 0 when there is no recorded last timestamp", () => {
    expect(remainingDebounceMs(null, 10_000, 3000)).toBe(0);
  });

  it("returns the positive remainder for a recent last timestamp", () => {
    // 1 second elapsed of a 3 second interval leaves 2 seconds.
    expect(remainingDebounceMs(9000, 10_000, 3000)).toBe(2000);
  });

  it("returns 0 for an old last timestamp", () => {
    expect(remainingDebounceMs(1000, 10_000, 3000)).toBe(0);
  });

  it("returns 0 when exactly the interval has elapsed", () => {
    expect(remainingDebounceMs(7000, 10_000, 3000)).toBe(0);
  });
});
