import { describe, expect, it } from "vitest";
import { isSystemReminder, wrapSystemReminder } from "./system-reminder.js";

describe("wrapSystemReminder / isSystemReminder", () => {
  it("wraps text in a system-reminder block", () => {
    expect(wrapSystemReminder("hello")).toBe("<system-reminder>\nhello\n</system-reminder>");
  });

  it("round-trips: a wrapped string is recognized as a system reminder", () => {
    expect(isSystemReminder(wrapSystemReminder("heartbeat check-in"))).toBe(true);
  });

  it("recognizes a wrapped block with surrounding whitespace", () => {
    expect(isSystemReminder("  \n<system-reminder>\nx\n</system-reminder>\n ")).toBe(true);
  });

  it("does not treat plain text as a system reminder", () => {
    expect(isSystemReminder("just a normal message")).toBe(false);
  });

  it("does not treat a turn that only STARTS with a reminder as fully system", () => {
    // e.g. a persona preamble prepended to a real user message.
    expect(
      isSystemReminder("<system-reminder>\npersona\n</system-reminder>\n\nreal user text"),
    ).toBe(false);
  });

  it("does not treat the bare marker with no body as a reminder", () => {
    expect(isSystemReminder("<system-reminder></system-reminder>")).toBe(false);
  });

  it("keys off the FIRST closing tag: trailing human text after it is not fully system", () => {
    // A mixed turn whose human text itself ends with the literal closing tag
    // must not be misclassified as fully system (the first close is not the end).
    const mixed =
      "<system-reminder>\ndirective\n</system-reminder>\n\nplease close the </system-reminder>";
    expect(isSystemReminder(mixed)).toBe(false);
  });
});
