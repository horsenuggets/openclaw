import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildMissingPermissionText,
  buildPermissionDeniedEmbed,
  buildUnauthorizedNoticeText,
  denyInteractionEphemeral,
  replyUnauthorizedEphemeral,
} from "./unauthorized-notice.js";

const runtime = { log: () => {}, error: () => {} };

/** Read a fetch init body as an object, whether JSON or multipart (payload_json). */
function bodyOf(init?: RequestInit): Record<string, unknown> {
  const raw =
    init?.body instanceof FormData
      ? (init.body.get("payload_json") as string)
      : ((init?.body as string) ?? "{}");
  return JSON.parse(raw);
}

describe("buildUnauthorizedNoticeText", () => {
  it("names the owner when known", () => {
    const text = buildUnauthorizedNoticeText("123", "456");
    expect(text).toContain("<#123>");
    expect(text).toContain("<@456>");
    expect(text).toContain("not authorized");
  });

  it("omits the owner mention when unknown", () => {
    const text = buildUnauthorizedNoticeText("123");
    expect(text).toContain("<#123>");
    expect(text).not.toContain("<@");
  });
});

describe("buildMissingPermissionText", () => {
  it("names the command and states the permission requirement", () => {
    expect(buildMissingPermissionText("debug")).toBe(
      "Sorry, but you do not have the necessary permissions to use the `/debug` command.",
    );
  });
});

describe("buildPermissionDeniedEmbed", () => {
  it("renders the notice as a Log-category embed with its icon attachment", () => {
    const built = buildPermissionDeniedEmbed(buildMissingPermissionText("debug"));
    expect(built.embed.description).toContain("necessary permissions");
    expect(built.embed.footer?.text).toBe("Log Message");
    expect(built.attachments).toEqual(["log-message.png"]);
  });
});

describe("denyInteractionEphemeral", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const stubFetch = () => {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, body: bodyOf(init) });
        return { ok: true, status: 200, json: async () => ({ attachments: [] }) };
      }) as unknown as typeof fetch,
    );
    return calls;
  };

  it("defers ephemerally, then edits in the permission embed", async () => {
    const calls = stubFetch();
    await denyInteractionEphemeral({
      applicationId: "app",
      interactionId: "int",
      interactionToken: "tok",
      notice: buildMissingPermissionText("debug"),
      runtime,
    });
    const defer = calls.find((c) => c.url.includes("/callback"));
    expect(defer).toBeDefined();
    const deferBody = defer!.body as { type?: number; data?: { flags?: number } };
    expect(deferBody.type).toBe(5);
    expect(deferBody.data?.flags).toBe(64);
    expect(calls.some((c) => c.url.includes("/messages/@original"))).toBe(true);
  });

  it("skips the defer when alreadyDeferred is set", async () => {
    const calls = stubFetch();
    await denyInteractionEphemeral({
      applicationId: "app",
      interactionId: "int",
      interactionToken: "tok",
      notice: buildMissingPermissionText("debug"),
      runtime,
      alreadyDeferred: true,
    });
    expect(calls.some((c) => c.url.includes("/callback"))).toBe(false);
    expect(calls.some((c) => c.url.includes("/messages/@original"))).toBe(true);
  });
});

describe("replyUnauthorizedEphemeral", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("defers then edits the channel-owner notice naming the owner", async () => {
    const bodies: { url: string; body: Record<string, unknown> }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        bodies.push({ url, body: bodyOf(init) });
        return { ok: true, status: 200, json: async () => ({ attachments: [] }) };
      }) as unknown as typeof fetch,
    );
    await replyUnauthorizedEphemeral({
      applicationId: "app",
      interactionId: "int",
      interactionToken: "tok",
      channelId: "123",
      ownerId: "456",
      runtime,
    });
    const edit = bodies.find((c) => c.url.includes("/messages/@original"));
    const embeds = edit?.body.embeds as Array<{ description?: string }> | undefined;
    expect(embeds?.[0]?.description).toContain("<@456>");
    expect(embeds?.[0]?.description).toContain("not authorized");
  });
});
