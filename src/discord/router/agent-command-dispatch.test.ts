import { describe, expect, it, vi } from "vitest";
import { runAgentCommandDispatch } from "./agent-command-dispatch.js";

function okSender() {
  return vi.fn(async () => ({ ok: true, status: 200 }));
}

describe("runAgentCommandDispatch", () => {
  it("returns null for the silent-reply `return` token without sending", async () => {
    const sendEmbed = okSender();
    const result = await runAgentCommandDispatch({ command: "return", args: [] }, "chan-1", {
      sendEmbed,
    });
    expect(result).toBeNull();
    expect(sendEmbed).not.toHaveBeenCalled();
  });

  it("posts the welcome embed for `send_hook_embed welcome`", async () => {
    const sendEmbed = okSender();
    const result = await runAgentCommandDispatch(
      { command: "send_hook_embed", args: ["welcome"] },
      "chan-1",
      { sendEmbed },
    );
    expect(result).toBe("welcome card sent");
    const [channelId, message] = sendEmbed.mock.calls[0];
    expect(channelId).toBe("chan-1");
    expect(message.attachments).toContain("general.png");
    expect(message.embeds[0].title).toBe("Welcome to OpenClaw!");
  });

  it("rejects an unknown hook embed name", async () => {
    const sendEmbed = okSender();
    const result = await runAgentCommandDispatch(
      { command: "send_hook_embed", args: ["bogus"] },
      "chan-1",
      { sendEmbed },
    );
    expect(result).toBe('error: unknown embed "bogus"');
    expect(sendEmbed).not.toHaveBeenCalled();
  });

  it("posts a Log embed for `log` and reports success", async () => {
    const sendEmbed = okSender();
    const result = await runAgentCommandDispatch(
      { command: "log", args: ["Back online after a restart"] },
      "chan-1",
      { sendEmbed },
    );
    expect(result).toBe("log sent");
    const [channelId, message] = sendEmbed.mock.calls[0];
    expect(channelId).toBe("chan-1");
    expect(message.attachments).toEqual(["log-message.png"]);
    expect(message.embeds[0].color).toBe(0xa0a0a0);
    expect(message.embeds[0].description).toBe("*Back online after a restart*");
  });

  it("relays a rejected log embed back to the agent as an error", async () => {
    const sendEmbed = vi.fn(async () => ({ ok: false, status: 429 }));
    const result = await runAgentCommandDispatch({ command: "log", args: ["hi"] }, "chan-1", {
      sendEmbed,
    });
    expect(result).toBe("error: log embed rejected (429)");
    expect(sendEmbed).toHaveBeenCalledTimes(1);
  });

  it("rejects an empty log message without sending", async () => {
    const sendEmbed = okSender();
    const result = await runAgentCommandDispatch({ command: "log", args: [] }, "chan-1", {
      sendEmbed,
    });
    expect(result).toBe("error: log requires a message");
    expect(sendEmbed).not.toHaveBeenCalled();
  });

  it("rejects an unknown command", async () => {
    const sendEmbed = okSender();
    const result = await runAgentCommandDispatch({ command: "frobnicate", args: [] }, "chan-1", {
      sendEmbed,
    });
    expect(result).toBe('error: unknown command "frobnicate"');
    expect(sendEmbed).not.toHaveBeenCalled();
  });
});
