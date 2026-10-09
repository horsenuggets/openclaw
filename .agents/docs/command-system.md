# Command System

How the Discord router handles slash and text commands, gates them, and tracks registered
channels. The command system lives almost entirely under `src/discord/router/`; it is the
multi-tenant router, separate from the generic `src/discord/monitor/` provider. (The
`src/commands/` directory is unrelated CLI commands.)

## The Commands

- `/channel` (`channel-commands.ts`, `CHANNEL_COMMAND_SPEC`) - register, show status for,
  or unregister a per-channel agent instance.
- `/lifecycle` (spec inline in `router.ts`) - show or toggle the startup and shutdown
  notification banners for a channel.
- `/secret` (`secret-command.ts`, `SECRET_COMMAND_SPEC`) - hand the channel's agent a
  sensitive value through a modal popup. The value never appears in the channel or logs.
- `/connections` with the `/conn` alias (`connect-commands.ts`) - link, list, or remove
  external accounts (Todoist, Notion, GitHub by pasted token; Google is coming soon) for
  the channel's agent. See [sandbox-and-permissions.md](sandbox-and-permissions.md).

## Slash versus Text Dispatch

Both funnel through the raw Discord gateway handlers in `gateway-events.ts`...

- Slash, modal, and button interactions go through `handleSlashInteraction`,
  `handleModalSubmit`, and `handleComponentInteraction`.
- A text fallback in `handleMessageCreate` parses `/channel` and `/connections` text forms
  (tolerating a `//` prefix) before the bot filter, so automation bots that cannot invoke
  slash commands can still drive them.
- A second, smaller text-command path for `/lifecycle` lives in `route-message.ts`
  (`KNOWN_TEXT_COMMANDS`, `isKnownTextCommand`, `handleTextCommand`). `/lifecycle` is the
  only entry there, `/channel` and `/connections` get their text forms from
  `gateway-events.ts` (above), and `/secret` has no text path at all (it is a slash
  interaction plus modal only). This split is a known inconsistency worth keeping in mind.

## Gating and Authorization

- Register is gated by a whitelist checker (`whitelist.ts`, `createWhitelistChecker`)
  driven by env (`OPENCLAW_AUTH_GUILD_ID`, `OPENCLAW_WHITELIST_ROLE_ID`,
  `OPENCLAW_ADMIN_ROLE_ID`), all fail-closed, with a short role cache. Unregister is not
  whitelist-gated » The recorded owner may always remove their own channel, and anyone
  else needs admin (a deliberate owner-recovery path). `OPENCLAW_ADMIN_OVERRIDE_IDS`
  grants admin unconditionally (used by lab rigs).
- Conversing and the `/lifecycle`, `/secret`, and `/connections` commands are owner-gated
  by `isAuthorizedForChannel` (`router.ts`) » Only the registered channel owner (from
  `.onboarding.json`) may use them. Denials go through the shared unauthorized notice
  (`unauthorized-notice.ts`), which is an ephemeral reply for interactions and a threaded
  log embed for plain messages.
- Channel-registration gating » The router only converses in channels present in its
  `instances` map. Unregistered guild channels are silently ignored; unregistered DMs get
  a "this channel is not registered" notice.
- Bot env knobs » `OPENCLAW_MOCK_USER_BOT_ID` marks a bot that is allowed to hold normal
  conversations (without it, the router filters the bot's chat and keeps re-firing
  onboarding, so only commands work). `OPENCLAW_ROUTER_OWNER_GATED_BOT_IDS` forces a test
  bot through the human owner gate. `OPENCLAW_ROUTER_UNAUTHORIZED_NOTICE` toggles the
  notice versus a silent deny.

## In-Box Command Policy

Inside each agent box, `src/auto-reply/command-policy.ts` gates in-session `/word`
commands. `ENABLED_COMMAND_KEYS` is intentionally empty » This fork owns `/channel`,
`/lifecycle`, `/secret`, and `/connections` host-side in the router, so inside the box no
in-session command is enabled and any such text reaches the model as plain content.

## Registration Flow

`/channel register` runs `handleChannelCommand`, which checks whitelist and admin
authorization (a non-admin whitelisted user may register only their own DM; the `owner`
argument that assigns the channel to another user is admin-only), then calls the injected
`ProvisioningClient.register`. Owner-gating applies to unregister and to the
conversational and agent commands, not to registering. Real provisioning is an HTTP call
to a host daemon over loopback using `OPENCLAW_PROVISIONER_PORT` and
`OPENCLAW_PROVISIONER_TOKEN`; without those it is a fail-closed stub. On success the
router calls `reloadInstances` to re-scan disk, then `kickOnboarding` fires the agent's
first turn. The channel-to-port map comes from `loadRouterConfig` scanning the instances
directory and reading each `.port` dotfile.

## Pitfalls

- The instance map is cached at startup. After any provisioning change you must call
  `reloadInstances`, or the channel will not become routable without a restart. On prod,
  re-registering reassigns ports, so restart the router afterward or moved channels get
  mis-routed.
- Two reply paths exist (see [architecture.md](architecture.md)). Bots cannot send true
  ephemerals, so `/channel` denials fall back to threaded real replies or persistent log
  embeds, not ephemerals.
- Defer-before-edit races » `/lifecycle`, `/connections`, and the secret acks must await
  the interaction defer before editing the original reply, or the follow-up fails.
- Token redaction » `/connections add <token>` text is scrubbed from the channel and logs,
  including reply-echo cases, and the pasted token is deleted even when auth is denied.
- The control-command relay » Agent output can carry `⁘` control commands, dispatched in
  `agent-command-dispatch.ts`. Only `return`, `send_hook_embed`, and `log` are
  implemented. The dispatcher unwraps code fences so that commands echoed inside docs
  still execute rather than leaking into chat, and the relay loop has a depth cap.
