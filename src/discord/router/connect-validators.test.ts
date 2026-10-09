import { afterEach, describe, expect, it, vi } from "vitest";
import { validateGithub, validateNotion, validateTodoist } from "./connect-validators.js";

/** Minimal fetch Response stub: only the fields the validators read. */
function response(status: number, body?: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body ?? {},
  } as unknown as Response;
}

/** Capture the last fetch call so header/endpoint assertions can inspect it. */
function stubFetch(resp: Response) {
  const mock = vi.fn().mockResolvedValue(resp);
  vi.stubGlobal("fetch", mock);
  return mock;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("validateTodoist", () => {
  it("confirms the token via the unified v1 projects endpoint with a bearer header", async () => {
    const mock = stubFetch(response(200, []));
    const result = await validateTodoist("tok_123");
    expect(result).toEqual({ ok: true });
    const [url, init] = mock.mock.calls[0];
    expect(url).toBe("https://api.todoist.com/api/v1/projects");
    expect((init as RequestInit).headers).toMatchObject({ Authorization: "Bearer tok_123" });
  });

  it("reports the status on a non-2xx response", async () => {
    stubFetch(response(401));
    expect(await validateTodoist("bad")).toEqual({ ok: false, message: "Todoist returned 401" });
  });
});

describe("validateNotion", () => {
  it("passes the Notion-Version header and returns the account name as the label", async () => {
    const mock = stubFetch(response(200, { name: "Ada" }));
    const result = await validateNotion("secret_abc");
    expect(result).toEqual({ ok: true, accountLabel: "Ada" });
    const [url, init] = mock.mock.calls[0];
    expect(url).toBe("https://api.notion.com/v1/users/me");
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: "Bearer secret_abc",
      "Notion-Version": "2022-06-28",
    });
  });

  it("omits the label when the response has no name", async () => {
    stubFetch(response(200, {}));
    expect(await validateNotion("secret_abc")).toEqual({ ok: true });
  });

  it("reports the status on a non-2xx response", async () => {
    stubFetch(response(403));
    expect(await validateNotion("bad")).toEqual({ ok: false, message: "Notion returned 403" });
  });
});

describe("validateGithub", () => {
  it("sends the GitHub headers and returns the login as the label", async () => {
    const mock = stubFetch(response(200, { login: "octocat" }));
    const result = await validateGithub("ghp_xyz");
    expect(result).toEqual({ ok: true, accountLabel: "octocat" });
    const [url, init] = mock.mock.calls[0];
    expect(url).toBe("https://api.github.com/user");
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: "Bearer ghp_xyz",
      Accept: "application/vnd.github+json",
      "User-Agent": "openclaw-connections",
    });
  });

  it("omits the label when the response has no login", async () => {
    stubFetch(response(200, {}));
    expect(await validateGithub("ghp_xyz")).toEqual({ ok: true });
  });

  it("reports the status on a non-2xx response", async () => {
    stubFetch(response(401));
    expect(await validateGithub("bad")).toEqual({ ok: false, message: "GitHub returned 401" });
  });
});
