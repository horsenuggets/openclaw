import { createHash, randomBytes, randomUUID } from "node:crypto";

const MINIMAX_OAUTH_BASE_URL = "https://api.minimax.io";
const MINIMAX_OAUTH_DEVICE_CODE_ENDPOINT = `${MINIMAX_OAUTH_BASE_URL}/oauth/code`;
const MINIMAX_OAUTH_TOKEN_ENDPOINT = `${MINIMAX_OAUTH_BASE_URL}/oauth/token`;
const MINIMAX_OAUTH_CLIENT_ID = "78257093-7e40-4613-99e0-527b14b39113";
const MINIMAX_OAUTH_SCOPE = "group_id profile model.completion";
const MINIMAX_OAUTH_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:user_code";

export type MiniMaxDeviceAuthorization = {
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval?: number;
  has_benefit: boolean;
  benefit_message: string;
};

export type MiniMaxOAuthToken = {
  access: string;
  refresh: string;
  expires: number;
  resourceUrl?: string;
};

type TokenPending = { status: "pending"; slowDown?: boolean };

type DeviceTokenResult =
  | { status: "success"; token: MiniMaxOAuthToken }
  | TokenPending
  | { status: "error"; message: string };

function toFormUrlEncoded(data: Record<string, string>): string {
  return Object.entries(data)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");
}

function generatePkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

async function requestDeviceCode(params: { challenge: string }): Promise<MiniMaxDeviceAuthorization> {
  const response = await fetch(MINIMAX_OAUTH_DEVICE_CODE_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      "x-request-id": randomUUID(),
    },
    body: toFormUrlEncoded({
      client_id: MINIMAX_OAUTH_CLIENT_ID,
      scope: MINIMAX_OAUTH_SCOPE,
      code_challenge: params.challenge,
      code_challenge_method: "S256",
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`MiniMax device authorization failed: ${text || response.statusText}`);
  }

  const payload = (await response.json()) as MiniMaxDeviceAuthorization & { error?: string };
  if (!payload.user_code || !payload.verification_uri) {
    throw new Error(
      payload.error ??
        "MiniMax device authorization returned an incomplete payload (missing user_code or verification_uri).",
    );
  }
  return payload;
}

async function pollDeviceToken(params: {
  userCode: string;
  verifier: string;
}): Promise<DeviceTokenResult> {
  const response = await fetch(MINIMAX_OAUTH_TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: toFormUrlEncoded({
      grant_type: MINIMAX_OAUTH_GRANT_TYPE,
      client_id: MINIMAX_OAUTH_CLIENT_ID,
      user_code: params.userCode,
      code_verifier: params.verifier,
    }),
  });

  if (!response.ok) {
    let payload: { error?: string; error_description?: string } | undefined;
    try {
      payload = (await response.json()) as { error?: string; error_description?: string };
    } catch {
      const text = await response.text();
      return { status: "error", message: text || response.statusText };
    }

    if (payload?.error === "authorization_pending") {
      return { status: "pending" };
    }

    if (payload?.error === "slow_down") {
      return { status: "pending", slowDown: true };
    }

    return {
      status: "error",
      message: payload?.error_description || payload?.error || response.statusText,
    };
  }

  const tokenPayload = (await response.json()) as {
    access_token?: string | null;
    refresh_token?: string | null;
    expires_in?: number | null;
    token_type?: string;
    resource_url?: string;
  };

  if (!tokenPayload.access_token || !tokenPayload.refresh_token || !tokenPayload.expires_in) {
    return { status: "error", message: "MiniMax OAuth returned incomplete token payload." };
  }

  return {
    status: "success",
    token: {
      access: tokenPayload.access_token,
      refresh: tokenPayload.refresh_token,
      expires: Date.now() + tokenPayload.expires_in * 1000,
      resourceUrl: tokenPayload.resource_url,
    },
  };
}

export async function loginMiniMaxPortalOAuth(params: {
  openUrl: (url: string) => Promise<void>;
  note: (message: string, title?: string) => Promise<void>;
  progress: { update: (message: string) => void; stop: (message?: string) => void };
}): Promise<MiniMaxOAuthToken> {
  const { verifier, challenge } = generatePkce();
  const device = await requestDeviceCode({ challenge });
  const verificationUrl = device.verification_uri;

  await params.note(
    [
      `Open ${verificationUrl} to approve access.`,
      `If prompted, enter the code ${device.user_code}.`,
    ].join("\n"),
    "MiniMax OAuth",
  );

  try {
    await params.openUrl(verificationUrl);
  } catch {
    // Fall back to manual copy/paste if browser open fails.
  }

  const start = Date.now();
  let pollIntervalMs = device.interval ? device.interval * 1000 : 2000;
  const timeoutMs = device.expires_in * 1000;

  while (Date.now() - start < timeoutMs) {
    params.progress.update("Waiting for MiniMax OAuth approval…");
    const result = await pollDeviceToken({
      userCode: device.user_code,
      verifier,
    });

    if (result.status === "success") {
      return result.token;
    }

    if (result.status === "error") {
      throw new Error(`MiniMax OAuth failed: ${result.message}`);
    }

    if (result.status === "pending" && result.slowDown) {
      pollIntervalMs = Math.min(pollIntervalMs * 1.5, 10000);
    }

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  throw new Error("MiniMax OAuth timed out waiting for authorization.");
}
