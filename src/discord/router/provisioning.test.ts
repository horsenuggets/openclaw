import { describe, expect, it, vi } from "vitest";
import { createHttpProvisioningClient, isSnowflake } from "./provisioning.js";

describe("isSnowflake", () => {
  it("accepts 17-20 digit ids and rejects others", () => {
    expect(isSnowflake("123456789012345678")).toBe(true);
    expect(isSnowflake("12345")).toBe(false);
    expect(isSnowflake("12345678901234567890x")).toBe(false);
  });
});

describe("createHttpProvisioningClient", () => {
  it("posts register with a bearer token and returns the daemon message", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, message: "registered and ready" }),
    }));
    const client = createHttpProvisioningClient({
      baseUrl: "http://127.0.0.1:18810",
      token: "secret",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await client.register({
      channelId: "111111111111111111",
      ownerId: "222222222222222222",
      isDM: false,
    });

    expect(result).toEqual({ ok: true, message: "registered and ready" });
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:18810/register");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer secret");
    expect(JSON.parse(init.body as string)).toEqual({
      channelId: "111111111111111111",
      ownerId: "222222222222222222",
      isDM: false,
    });
  });

  it("treats a non-2xx response as a failure", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 500,
      json: async () => ({ ok: false, message: "boom" }),
    }));
    const client = createHttpProvisioningClient({
      baseUrl: "http://127.0.0.1:18810",
      token: "secret",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const result = await client.unregister({ channelId: "111111111111111111" });
    expect(result.ok).toBe(false);
    expect(result.message).toBe("boom");
  });

  it("reports a friendly error when the daemon is unreachable", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const client = createHttpProvisioningClient({
      baseUrl: "http://127.0.0.1:18810",
      token: "secret",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const result = await client.register({
      channelId: "111111111111111111",
      ownerId: "222222222222222222",
      isDM: true,
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("Could not reach");
  });
});
