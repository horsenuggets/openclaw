# Auth and Billing

The Anthropic providers, how OAuth tokens are stored and refreshed, and how the
subscription provider stays on free plan quota. Pairs with
[system-prompt.md](system-prompt.md).

## The Two Providers

- `anthropic-api` - API-key billing (`x-api-key` auth).
- `anthropic-subscription` - Claude subscription billing (OAuth Bearer auth, with the
  Claude Code system-prompt prefix).

Both call the Anthropic API directly through pi-ai (`@mariozechner/pi-ai`) with prompt
caching, replacing the old `claude-cli` backend. A request is treated as subscription when
the provider is `anthropic-subscription` or the provider config has `auth: "oauth"`
(`needsSubscriptionSystemPrompt`).

## Token Storage and Resolution

`src/agents/models-config.providers.ts` fills a missing `apiKey` from env or the
auth-profile store (`resolveApiKeyFromProfiles`, `resolveEnvApiKeyVarName`). OAuth
resolution and refresh live in `src/agents/auth-profiles/oauth.ts`:
`resolveApiKeyForProfile` returns the token and refreshes it via a lockfile when expired.
`anthropic-subscription` is special-cased to call pi-ai's refresh directly because pi-ai
registers it under "anthropic". Secondary agents fall back to the main agent's
credentials.

Credentials live in `auth-profiles.json` in the agent directory, under the canonical
profile id `anthropic-subscription:default`. On deploy hosts the profiles live in a shared
store at `~/.openclaw-instances/shared/auth/`, but only the router container mounts that
store (read-write, so it can refresh tokens). The hardened agent boxes mount no
credentials at all; the router's model proxy injects the bearer for each token-free box.

## Minting a Token

`scripts/mint-anthropic-reauth.sh` SSH-tunnels an OAuth callback to the deploy host and
runs `openclaw auth mint-anthropic --store shared|main --callback-port N` (command
implementation in `src/commands/auth-mint-anthropic.ts`). On the mirror rig,
`scripts/prod-mirror.sh mint` does the equivalent. A minted token is short-lived (on the
order of a day); refresh is automatic through `oauth.ts`, but if replies start failing
with 502s, re-mint. An empty or stale store is the usual cause of "Unknown model" on the
subscription path.

## Plan Quota versus Extra Usage

For the subscription (OAuth) provider the Anthropic endpoint decides, per request, whether
to bill the free plan quota or paid extra usage. A request bills to plan quota when all
of...

1. pi-ai's Claude Code identity is system block 0 (exactly
   `You are Claude Code, Anthropic's official CLI for Claude.`),
2. the system block stays a lean, Claude-Code-consistent prompt with no OpenClaw-divergent
   operational content, and
3. all OpenClaw-specific content rides the conversation (the `<system-reminder>`
   preamble), which is billing-neutral.

Content divergence in the system prompt, not request size, is the trigger. See
[system-prompt.md](system-prompt.md) for how the code arranges this.

## The Billing Probe

`scripts/subscription-billing-probe.ts` fires labeled live requests with the Claude Code
OAuth headers and reports, per case, whether each bills to plan quota (a 200 with
`service_tier: "standard"`) or spills to extra usage (a 400 "out of extra usage"). The
spill signal only works when the account's extra-usage balance is already 0, so the script
runs the known-spill controls first and aborts if they do not 400. Use it after changing
anything that touches the system prompt on the subscription path. To capture a real
payload for bisecting, use the payload-log env vars in
[logs-and-debugging.md](logs-and-debugging.md).

## The Model-Catalog Gotcha

Models come from pi-ai's built-in catalog plus the provider configs, and a model is only
"available" when its provider has auth configured. Two independent causes of
`Unknown model: <provider>/<id>`...

1. Auth-gated catalog. With an empty or expired auth store the subscription provider
   registers no models, so even a valid id resolves as unknown. Mint a token first.
2. Wrong id for this checkout. The id set comes from the pinned pi-ai version
   (`node_modules/@mariozechner/pi-ai`). An id the team uses by habit may simply not exist
   in this checkout's catalog. Confirm the id is in the current catalog before assuming a
   code bug.
