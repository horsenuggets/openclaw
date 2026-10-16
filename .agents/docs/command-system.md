# Command System

How the Discord router handles slash and text commands, gates them, and tracks registered
channels. The command system lives almost entirely under `src/discord/router/`; it is the
multi-tenant router, separate from the generic `src/discord/monitor/` provider. (The
`src/commands/` directory is unrelated CLI commands.)

## The Commands

- `/channel` (`channel-commands.ts`, `CHANNEL_COMMAND_SPEC`) - register, show status for,
  or unregister a per-channel agent instance.
- `/lifecycle` (`lifecycle-command.ts`, `LIFECYCLE_COMMAND_SPEC`) - show or toggle the
  startup and shutdown notification banners for a channel.
- `/secret` (`secret-command.ts`, `SECRET_COMMAND_SPEC`) - hand the channel's agent a
  sensitive value through a modal popup. The value never appears in the channel or logs.
- `/connections` with the `/conn` alias (`connect-commands.ts`) - link, list, show every
  available service for, or remove external accounts (Todoist, Notion, GitHub by pasted
  token; Google is listed and selectable but its connect flow is not wired yet, so
  `/connections add google` shows a TODO placeholder) for the channel's agent. The
  `available` subcommand renders a bare embed carrying only the Available Services field
  (no title or description); `info <service>` shows a per-connection stats embed (status
  glyph, account, linked date, auth type derived from the connector's auth flow, a
  placeholder last-ping, and a Skills Available list) with an action row of a
  Reauthenticate button (`conn:reauth:<id>`) followed by a danger Remove Connection button
  (`conn:remove:<id>`), both handled in `gateway-events.ts` (currently a TODO ephemeral
  reply). See [sandbox-and-permissions.md](sandbox-and-permissions.md).
- `/debug` (`debug-command.ts`, `DEBUG_COMMAND_SPEC`) - an admin-only console for
  inspecting internal state. Rather than registering each tool as its own slash command,
  the subcommand is entered as free text into a single `command` option (for example
  `echo "hello world"`) and parsed by our own quote-aware command-string parser
  (`tokenizeDebugCommand` / `parseDebugCommand`). Subcommands live in `DEBUG_SUBCOMMANDS`
  (currently `echo`, `secrettest`, and `help`); `help` (also the empty-input default)
  renders a Debug-category embed listing every subcommand alphabetically, overflowing
  across extra embeds within Discord's shared per-message limit (6000 characters across at
  most 10 embeds, 25 fields each) with a truncation note past that.
  `secrettest <value> [name]` is a testing convenience that hands the channel's agent a
  secret like `/secret`, but with the value passed as plaintext (so it only ever carries
  throwaway test values). Keeping subcommands behind the one free-text option (rather than
  registering each as its own slash command) is what hides them from the public slash
  picker; `/debug` itself is still globally registered and visible, gated at runtime by
  the admin check. Slash replies are ephemeral by default, so debug output stays out of
  the channel, unless a tester flips the channel public with `/debug ephemeral off` (the
  per-channel `ephemeralCommands` preference, default on; see below). `/debug` also has an
  admin-gated text path (`parseDebugTextCommand`) for automation/tester bots, whose
  replies are in-channel because bots cannot send ephemerals. See
  [debug-command.md](debug-command.md) for usage and how to add a subcommand.

These five (six counting the `/conn` alias) are the only slash commands the bot should
expose. On startup `startRouter` registers them with a single bulk-overwrite
`PUT /applications/{id}/commands` carrying exactly these specs. The `PUT` replaces the
application's whole global command list atomically, so any stale command from an older
build (or a built-in command ever deployed under the same bot) is removed, and no command
can end up registered twice. A `POST` per command would only ever add-or-upsert and could
never prune, which is how non-custom commands used to accumulate in the picker.

We only ever register global commands. On each gateway `READY`, the router also clears
guild-scoped commands for every guild it is in (`clearGuildScopedCommands`, a
`PUT .../guilds/{id}/commands` with an empty list, once per guild per process). A
guild-scoped command is always a stale leftover (an older build or a one-off manual
registration), and Discord would render it as a duplicate next to the global one in that
guild's picker, so clearing it self-heals the duplicate and keeps global the single source
of truth.

## Slash versus Text Dispatch

Both funnel through the raw Discord gateway handlers in `gateway-events.ts`...

- Slash, modal, and button interactions go through `handleSlashInteraction`,
  `handleModalSubmit`, and `handleComponentInteraction`.
- A text fallback in `handleMessageCreate` parses `/channel`, `/connections`, and `/debug`
  text forms (tolerating a `//` prefix) before the bot filter, so automation bots that
  cannot invoke slash commands can still drive them. The `/debug` text path is admin-gated
  (same check as the slash path) and its replies are in-channel rather than ephemeral.
- A second, smaller text-command path for `/lifecycle` lives in `route-message.ts`
  (`KNOWN_TEXT_COMMANDS`, `isKnownTextCommand`, `handleTextCommand`). `/lifecycle` is the
  only entry there, `/channel`, `/connections`, and `/debug` get their text forms from
  `gateway-events.ts` (above), and `/secret` has no text path at all (it is a slash
  interaction plus modal only). This split is a known inconsistency worth keeping in mind.

## Gating and Authorization

- Register is gated by a whitelist checker (`whitelist.ts`, `createWhitelistChecker`)
  driven by env (`OPENCLAW_AUTH_GUILD_ID`, `OPENCLAW_WHITELIST_ROLE_ID`,
  `OPENCLAW_ADMIN_ROLE_ID`), all fail-closed, with a short role cache. Unregister is not
  whitelist-gated » The recorded owner may always remove their own channel, and anyone
  else needs admin (a deliberate owner-recovery path). `OPENCLAW_ADMIN_OVERRIDE_IDS`
  grants admin unconditionally (used by lab rigs).
- Every permission denial, for every slash command, renders the SAME ephemeral embed
  (`unauthorized-notice.ts`). This is a hard invariant: a denial is ALWAYS ephemeral, even
  on a channel whose `ephemeralCommands` preference is off (public). Because Discord fixes
  a reply's ephemerality at defer time and it cannot be changed afterward, any command
  that can deny must either authorize before its first interaction response or let the
  denial issue its own ephemeral defer; `/debug` (admin gate before the defer) and
  `/channel` register/unregister (authorization now evaluated BEFORE the defer via
  `isAuthorizedForChannelCommand`, so a denial forces an ephemeral defer while an
  authorized caller defers on the preference) both do this so a non-admin probe cannot
  publish a permission embed to the channel. For `/channel`, authorization is also
  re-checked AFTER the defer (the owner/admin revalidation and the stale-registration
  nonce guard, plus the unregister confirm-button click), so a role revoked in that window
  could still produce a late denial on an already-public deferred reply. Those late
  denials are marked with a `denied` flag on the reply (every `/channel` reply sets
  `ephemeral`, so ephemerality alone cannot tell a denial from a success); only a `denied`
  reply is rerouted. The reroute order is fixed: the public placeholder is first edited to
  a neutral, embed-free note (which also strips any denial embed), and ONLY on a
  successful edit is the denial posted as a separate EPHEMERAL follow-up (flags 64); a
  failed neutralize withholds the follow-up rather than risk a public denial.
  `/channel status` never denies, so it always follows the channel's `ephemeralCommands`
  preference like the conversational commands. `buildPermissionDeniedEmbed` builds the
  Log-category embed; `denyInteractionEphemeral` defers the interaction ephemerally (or
  skips the defer when the handler already deferred ephemerally) and edits the embed into
  the reply. Two notice flavors feed it: `buildUnauthorizedNoticeText` (channel-ownership
  denial, names the owner) and `buildMissingPermissionText` (generic "you do not have the
  necessary permissions to use `/<command>`" for globally gated commands). Plain-message
  denials reuse the same embed builder, posted as a threaded reply instead of an ephemeral
  one. New slash commands get this behavior by calling the shared helper rather than
  inventing their own denial.
- Conversing and the `/lifecycle`, `/secret`, and `/connections` commands are owner-gated
  by `isAuthorizedForChannel` (`router.ts`) » Only the registered channel owner (from
  `.onboarding.json`) may use them. `/connections available` is the exception: it lists
  only the static connector catalog, so it is accessible before registration and without
  an owner check. Non-owners of all other gated commands get the channel-ownership denial
  embed (`replyUnauthorizedEphemeral`, the thin owner-naming wrapper over
  `denyInteractionEphemeral`). The gate runs regardless of registration state » an
  unregistered channel has no owner, so `isAuthorizedForChannel` fails closed and denies
  rather than letting a command fall through to a "not registered yet" reply that would
  leak the registration state to a non-owner. A 1:1 DM is exempt (the caller is its own
  owner), and on an unregistered DM other connections commands still report that it is not
  registered.
- `/debug` is gated differently » It is admin-gated via `whitelist.isAdmin` (the
  `GatewayContext.isAdmin` closure), not owner-gated, because it inspects global internal
  state rather than one channel's agent. The admin check runs BEFORE the interaction is
  deferred, so a non-admin denial issues its own ephemeral defer via
  `denyInteractionEphemeral` (with `buildMissingPermissionText`) and can never leak to a
  channel whose `ephemeralCommands` preference is public. Only once the admin check passes
  does the handler defer with the channel's resolved ephemeral flag; an admin's reply is
  then embeds (`help` / notices / the `ephemeral` toggle) or raw content (`echo`).
- The `ephemeralCommands` preference (per-channel, stored in `preferences-store.ts`,
  default on) controls whether slash-command OUTPUT is ephemeral.
  `/debug ephemeral [on|off]` reads/sets it; turning it off makes command results persist
  in-channel so they can be inspected during testing. It governs the conversational
  command replies (`/debug`, `/lifecycle`, `/connections`, and all `/channel` subcommand
  output, including `register` and `unregister`). Every `/channel` subcommand follows the
  preference on SUCCESS now that authorization runs before the defer
  (`isAuthorizedForChannelCommand`); only a permission denial is forced ephemeral
  regardless, so it never leaks to a public channel.
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
`/lifecycle`, `/secret`, `/connections`, and `/debug` host-side in the router, so inside
the box no in-session command is enabled and any such text reaches the model as plain
content.

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
