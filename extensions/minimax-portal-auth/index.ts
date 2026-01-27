import { emptyPluginConfigSchema } from "clawdbot/plugin-sdk";

import { loginMiniMaxPortalOAuth } from "./oauth.js";

const PROVIDER_ID = "minimax-portal";
const PROVIDER_LABEL = "MiniMax";
const DEFAULT_MODEL = "MiniMax-M2.1";
const DEFAULT_BASE_URL = "https://api.minimax.io/v1";
const DEFAULT_CONTEXT_WINDOW = 200000;
const DEFAULT_MAX_TOKENS = 8192;
const OAUTH_PLACEHOLDER = "minimax-portal-oauth";

function normalizeBaseUrl(value: string | undefined): string {
  const raw = value?.trim() || DEFAULT_BASE_URL;
  const withProtocol = raw.startsWith("http") ? raw : `https://${raw}`;
  return withProtocol.endsWith("/v1") ? withProtocol : `${withProtocol.replace(/\/+$/, "")}/v1`;
}

function buildModelDefinition(params: { id: string; name: string; input: Array<"text" | "image"> }) {
  return {
    id: params.id,
    name: params.name,
    reasoning: false,
    input: params.input,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
  };
}

const minimaxPortalPlugin = {
  id: "minimax-portal-auth",
  name: "MiniMax OAuth",
  description: "OAuth flow for MiniMax (free-tier) models",
  configSchema: emptyPluginConfigSchema(),
  register(api) {
    api.registerProvider({
      id: PROVIDER_ID,
      label: PROVIDER_LABEL,
      docsPath: "/providers/minimax",
      aliases: ["minimax"],
      auth: [
        {
          id: "device",
          label: "MiniMax OAuth",
          hint: "Device code login",
          kind: "device_code",
          run: async (ctx) => {
            const progress = ctx.prompter.progress("Starting MiniMax OAuth…");
            try {
              const result = await loginMiniMaxPortalOAuth({
                openUrl: ctx.openUrl,
                note: ctx.prompter.note,
                progress,
              });

              progress.stop("MiniMax OAuth complete");

              const profileId = `${PROVIDER_ID}:default`;
              const baseUrl = normalizeBaseUrl(result.resourceUrl);

              return {
                profiles: [
                  {
                    profileId,
                    credential: {
                      type: "oauth",
                      provider: PROVIDER_ID,
                      access: result.access,
                      refresh: result.refresh,
                      expires: result.expires,
                    },
                  },
                ],
                configPatch: {
                  models: {
                    providers: {
                      [PROVIDER_ID]: {
                        baseUrl,
                        apiKey: OAUTH_PLACEHOLDER,
                        api: "anthropic-messages",
                        models: [
                          buildModelDefinition({
                            id: "MiniMax-M2.1",
                            name: "MiniMax M2.1",
                            input: ["text"],
                          }),
                          buildModelDefinition({
                            id: "MiniMax-M2.1-lightning",
                            name: "MiniMax M2.1 Lightning",
                            input: ["text"],
                          }),
                        ],
                      },
                    },
                  },
                  agents: {
                    defaults: {
                      models: {
                        "MiniMax-M2.1": { alias: "minimax" },
                      },
                    },
                  },
                },
                defaultModel: DEFAULT_MODEL,
                notes: [
                  "MiniMax OAuth tokens auto-refresh. Re-run login if refresh fails or access is revoked.",
                  `Base URL defaults to ${DEFAULT_BASE_URL}. Override models.providers.${PROVIDER_ID}.baseUrl if needed.`,
                ],
              };
            } catch (err) {
              progress.stop("MiniMax OAuth failed");
              await ctx.prompter.note(
                "If OAuth fails, verify your MiniMax account has portal access and try again.",
                "MiniMax OAuth",
              );
              throw err;
            }
          },
        },
      ],
    });
  },
};

export default minimaxPortalPlugin;
