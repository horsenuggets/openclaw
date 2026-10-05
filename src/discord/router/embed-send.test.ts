import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearEmbedCdnCache,
  discordSendReply,
  editInteractionEmbedReply,
  sendEmbedMessage,
} from "./discord-api.js";
import { buildEmbed } from "./embed-categories.js";

// A Discord CDN URL whose signed expiry (ex=, hex epoch seconds) is far in the
// future, so the cache keeps it fresh for the whole test.
const CDN_URL = "https://cdn.discordapp.com/attachments/1/2/general.png?ex=ffffffff&is=0&hm=0";

let calls: Array<{ url: string; init: RequestInit }>;

function stubFetch(attachmentUrl = CDN_URL) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      // Echo back the uploaded filenames (as Discord does) so the cache warms
      // for whichever icons the request actually sent.
      let attachments: { filename: string; url: string }[] = [];
      if (init.body instanceof FormData) {
        const payloadJson = init.body.get("payload_json");
        if (typeof payloadJson === "string") {
          const parsed = JSON.parse(payloadJson) as {
            attachments?: { filename: string }[];
          };
          attachments = (parsed.attachments ?? []).map((att) => ({
            filename: att.filename,
            url: attachmentUrl,
          }));
        }
      }
      return new Response(JSON.stringify({ attachments }), { status: 200 });
    }),
  );
}

beforeEach(() => {
  calls = [];
  clearEmbedCdnCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
  clearEmbedCdnCache();
});

describe("sendEmbedMessage", () => {
  it("posts plain JSON when there are no attachments", async () => {
    stubFetch();
    await sendEmbedMessage("tok", "chan-1", { embeds: [{ description: "hi" }] });
    expect(calls).toHaveLength(1);
    const { init } = calls[0];
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    const body = JSON.parse(init.body as string);
    expect(body.embeds).toEqual([{ description: "hi" }]);
  });

  it("uploads referenced icons as multipart, then reuses the cached CDN URL", async () => {
    stubFetch();
    const { embed, attachments } = buildEmbed({ category: "general", description: "first" });

    // First send uploads the icon file (multipart form-data).
    await sendEmbedMessage("tok", "chan-1", { embeds: [embed], attachments });
    expect(calls).toHaveLength(1);
    expect(calls[0].init.body).toBeInstanceOf(FormData);
    const form = calls[0].init.body as FormData;
    expect(form.get("payload_json")).toBeTypeOf("string");
    expect(form.get("files[0]")).toBeInstanceOf(Blob);
    // No JSON Content-Type header on multipart (fetch sets the boundary).
    expect((calls[0].init.headers as Record<string, string>)["Content-Type"]).toBeUndefined();

    // Second send reuses the cached CDN URL: plain JSON, no upload, footer icon
    // rewritten from attachment:// to the cached URL.
    const second = buildEmbed({ category: "general", description: "second" });
    await sendEmbedMessage("tok", "chan-1", {
      embeds: [second.embed],
      attachments: second.attachments,
    });
    expect(calls).toHaveLength(2);
    expect(calls[1].init.body).not.toBeInstanceOf(FormData);
    const body = JSON.parse(calls[1].init.body as string);
    expect(body.embeds[0].footer.icon_url).toBe(CDN_URL);
  });

  it("re-uploads after the cache is cleared", async () => {
    stubFetch();
    const { embed, attachments } = buildEmbed({ category: "general", description: "x" });
    await sendEmbedMessage("tok", "chan-1", { embeds: [embed], attachments });
    clearEmbedCdnCache();
    const again = buildEmbed({ category: "general", description: "y" });
    await sendEmbedMessage("tok", "chan-1", {
      embeds: [again.embed],
      attachments: again.attachments,
    });
    expect(calls[0].init.body).toBeInstanceOf(FormData);
    expect(calls[1].init.body).toBeInstanceOf(FormData);
  });

  it("drops the reference for an icon file that cannot be read", async () => {
    stubFetch();
    await sendEmbedMessage("tok", "chan-1", {
      embeds: [{ description: "x", footer: { text: "X", icon_url: "attachment://nope.png" } }],
      attachments: ["nope.png"],
    });
    expect(calls[0].init.body).not.toBeInstanceOf(FormData);
    const body = JSON.parse(calls[0].init.body as string);
    expect(body.embeds[0].footer.icon_url).toBeUndefined();
  });

  it("includes a message_reference when replying", async () => {
    stubFetch();
    await sendEmbedMessage("tok", "chan-1", {
      embeds: [{ description: "hi" }],
      messageReference: { message_id: "m1", channel_id: "chan-1", fail_if_not_exists: false },
    });
    const body = JSON.parse(calls[0].init.body as string);
    expect(body.message_reference).toEqual({
      message_id: "m1",
      channel_id: "chan-1",
      fail_if_not_exists: false,
    });
  });

  it("forwards allowed_mentions to the payload", async () => {
    stubFetch();
    await sendEmbedMessage("tok", "chan-1", {
      embeds: [{ description: "hi" }],
      allowedMentions: { parse: [], replied_user: false },
    });
    const body = JSON.parse(calls[0].init.body as string);
    expect(body.allowed_mentions).toEqual({ parse: [], replied_user: false });
  });
});

describe("discordSendReply", () => {
  it("suppresses pings on an embed reply when allowed_mentions is passed", async () => {
    stubFetch();
    await discordSendReply(
      "tok",
      "chan-1",
      "m1",
      { embeds: [{ description: "not authorized" }] },
      { parse: [], replied_user: false },
    );
    const body = JSON.parse(calls[0].init.body as string);
    expect(body.message_reference.message_id).toBe("m1");
    expect(body.allowed_mentions).toEqual({ parse: [], replied_user: false });
  });
});

describe("sendEmbedMessage cache lifetime", () => {
  it("reuses the cached URL within the 12h window", async () => {
    vi.useFakeTimers();
    try {
      stubFetch();
      const a = buildEmbed({ category: "general", description: "a" });
      await sendEmbedMessage("tok", "chan-1", { embeds: [a.embed], attachments: a.attachments });
      expect(calls[0].init.body).toBeInstanceOf(FormData);

      vi.advanceTimersByTime(11 * 60 * 60 * 1000); // 11h < 12h TTL
      const b = buildEmbed({ category: "general", description: "b" });
      await sendEmbedMessage("tok", "chan-1", { embeds: [b.embed], attachments: b.attachments });
      expect(calls[1].init.body).not.toBeInstanceOf(FormData);
    } finally {
      vi.useRealTimers();
    }
  });

  it("re-uploads after the 12h TTL expires", async () => {
    vi.useFakeTimers();
    try {
      stubFetch(); // default URL's ex is far in the future, so the 12h TTL is the limiter
      const a = buildEmbed({ category: "general", description: "a" });
      await sendEmbedMessage("tok", "chan-1", { embeds: [a.embed], attachments: a.attachments });

      vi.advanceTimersByTime(12 * 60 * 60 * 1000 + 1000); // just past the TTL
      const b = buildEmbed({ category: "general", description: "b" });
      await sendEmbedMessage("tok", "chan-1", { embeds: [b.embed], attachments: b.attachments });
      expect(calls[1].init.body).toBeInstanceOf(FormData);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clamps the cache lifetime to Discord's signed expiry when it is sooner", async () => {
    vi.useFakeTimers();
    try {
      // Signed URL that expires in 1 hour (ex = hex epoch seconds).
      const exSeconds = Math.floor(Date.now() / 1000) + 3600;
      const url = `https://cdn.discordapp.com/attachments/1/2/general.png?ex=${exSeconds.toString(16)}&is=0&hm=0`;
      stubFetch(url);
      const a = buildEmbed({ category: "general", description: "a" });
      await sendEmbedMessage("tok", "chan-1", { embeds: [a.embed], attachments: a.attachments });

      vi.advanceTimersByTime(61 * 60 * 1000); // >1h: past the signed expiry, well under 12h
      const b = buildEmbed({ category: "general", description: "b" });
      await sendEmbedMessage("tok", "chan-1", { embeds: [b.embed], attachments: b.attachments });
      expect(calls[1].init.body).toBeInstanceOf(FormData);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not cache when the upload response is not ok", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return new Response("boom", { status: 500 });
      }),
    );
    const a = buildEmbed({ category: "general", description: "a" });
    await sendEmbedMessage("tok", "chan-1", { embeds: [a.embed], attachments: a.attachments });
    const b = buildEmbed({ category: "general", description: "b" });
    await sendEmbedMessage("tok", "chan-1", { embeds: [b.embed], attachments: b.attachments });
    // Both attempts upload because the failed response never populated the cache.
    expect(calls[0].init.body).toBeInstanceOf(FormData);
    expect(calls[1].init.body).toBeInstanceOf(FormData);
  });
});

describe("editInteractionEmbedReply", () => {
  it("PATCHes the interaction @original and uploads the icon on a cold cache", async () => {
    stubFetch();
    const { embed, attachments } = buildEmbed({
      category: "registration",
      title: "Status",
      description: "d",
    });
    await editInteractionEmbedReply("app-1", "tok-1", {
      embeds: [embed],
      attachments,
      components: [],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(
      "https://discord.com/api/v10/webhooks/app-1/tok-1/messages/@original",
    );
    expect(calls[0].init.method).toBe("PATCH");
    // Cold cache: the icon is uploaded as multipart (resolving the footer icon).
    expect(calls[0].init.body).toBeInstanceOf(FormData);
    const form = calls[0].init.body as FormData;
    expect(form.get("files[0]")).toBeInstanceOf(Blob);
    // components are always sent (so an edit can clear a previous action row).
    expect(JSON.parse(form.get("payload_json") as string).components).toEqual([]);
  });

  it("reuses the cached CDN URL on a warm cache (JSON, no re-upload)", async () => {
    stubFetch();
    // Warm the cache via an initial channel send.
    const warm = buildEmbed({ category: "registration", description: "warm" });
    await sendEmbedMessage("tok", "chan-1", {
      embeds: [warm.embed],
      attachments: warm.attachments,
    });

    const next = buildEmbed({ category: "registration", title: "Done", description: "d" });
    await editInteractionEmbedReply("app-1", "tok-1", {
      embeds: [next.embed],
      attachments: next.attachments,
      components: [],
    });
    const editCall = calls[1];
    expect(editCall.init.body).not.toBeInstanceOf(FormData);
    const body = JSON.parse(editCall.init.body as string);
    expect(body.embeds[0].footer.icon_url).toBe(CDN_URL);
  });

  it("returns the HTTP status on failure so callers can log it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return new Response("bad request", { status: 400 });
      }),
    );
    const res = await editInteractionEmbedReply("app-1", "tok-1", {
      embeds: [{ description: "x" }],
      components: [],
    });
    expect(res).toEqual({ ok: false, status: 400 });
  });
});
