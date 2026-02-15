import { describe, expect, it } from "vitest";
import { resolveDiscordReplyDeliveryPlan } from "./threading.js";

describe("Discord thread reply references", () => {
  it("always uses reply reference when inside a thread, regardless of replyToMode", () => {
    const threadChannel = { id: "thread123", name: "Test Thread" };
    const messageId = "msg456";

    // Test with replyToMode: "off" - should STILL use the reference inside a thread
    const planOff = resolveDiscordReplyDeliveryPlan({
      replyTarget: "channel:thread123",
      replyToMode: "off",
      messageId,
      threadChannel,
      createdThreadId: null,
    });
    expect(planOff.replyReference.use()).toBe(messageId);

    // Test with replyToMode: "all" - should use the reference
    const planAll = resolveDiscordReplyDeliveryPlan({
      replyTarget: "channel:thread123",
      replyToMode: "all",
      messageId,
      threadChannel,
      createdThreadId: null,
    });
    expect(planAll.replyReference.use()).toBe(messageId);

    // Test with replyToMode: "first-only" - should STILL use the reference inside a thread
    const planFirst = resolveDiscordReplyDeliveryPlan({
      replyTarget: "channel:thread123",
      replyToMode: "first-only",
      messageId,
      threadChannel,
      createdThreadId: null,
    });
    expect(planFirst.replyReference.use()).toBe(messageId);
  });

  it("respects replyToMode when NOT in a thread", () => {
    const messageId = "msg456";

    // When not in a thread and replyToMode is "off", should NOT use reference
    const planOff = resolveDiscordReplyDeliveryPlan({
      replyTarget: "channel:parent123",
      replyToMode: "off",
      messageId,
      threadChannel: null,
      createdThreadId: null,
    });
    expect(planOff.replyReference.use()).toBeUndefined();

    // When not in a thread and replyToMode is "all", should use reference
    const planAll = resolveDiscordReplyDeliveryPlan({
      replyTarget: "channel:parent123",
      replyToMode: "all",
      messageId,
      threadChannel: null,
      createdThreadId: null,
    });
    expect(planAll.replyReference.use()).toBe(messageId);

    // When not in a thread and replyToMode is "first-only", first call should use reference
    const planFirst = resolveDiscordReplyDeliveryPlan({
      replyTarget: "channel:parent123",
      replyToMode: "first-only",
      messageId,
      threadChannel: null,
      createdThreadId: null,
    });
    expect(planFirst.replyReference.use()).toBe(messageId);
    // Second call should NOT use reference (first-only)
    expect(planFirst.replyReference.use()).toBeUndefined();
  });

  it("disables reply references when creating a new thread", () => {
    const messageId = "msg456";
    const createdThreadId = "newthread789";

    const plan = resolveDiscordReplyDeliveryPlan({
      replyTarget: "channel:parent123",
      replyToMode: "all",
      messageId,
      threadChannel: null,
      createdThreadId,
    });

    // Should deliver to the new thread
    expect(plan.deliverTarget).toBe(`channel:${createdThreadId}`);
    expect(plan.replyTarget).toBe(`channel:${createdThreadId}`);
    // Should NOT use reply reference (messages inside a newly created thread shouldn't reference)
    expect(plan.replyReference.use()).toBeUndefined();
  });

  it("handles thread channel without parentId", () => {
    const threadChannel = { id: "thread123" }; // No name or parentId
    const messageId = "msg456";

    const plan = resolveDiscordReplyDeliveryPlan({
      replyTarget: "channel:thread123",
      replyToMode: "off",
      messageId,
      threadChannel,
      createdThreadId: null,
    });

    // Should still use reply reference inside the thread
    expect(plan.replyReference.use()).toBe(messageId);
  });
});
