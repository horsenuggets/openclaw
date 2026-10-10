# Debug Command

`/debug` is an admin-only console for inspecting and poking the bot's internal state from
Discord. It is deliberately built as a single slash command with one free-text option
whose value is parsed into a SUBCOMMAND by our own parser, instead of registering each
tool as its own Discord slash command. That keeps the (potentially large and growing) set
of internal debugging tools out of the public slash-command picker, where regular users
would otherwise see and try them.

All of it lives under `src/discord/router/`:

- `debug-command.ts` - the parser, the subcommand registry, and the help builder. It
  performs no Discord I/O; it just turns a command string into a `DebugResult`. That
  result is still Discord-shaped, though: it carries embed payloads plus attachment names,
  or raw message content.
- `gateway-events.ts` (`handleSlashInteraction`) - the router adapter that admin-gates the
  interaction, defers it ephemerally, runs the command, and renders the result.
  `handleMessageCreate` also carries a text-command path (`parseDebugTextCommand`) so an
  automation/tester bot that cannot invoke slash commands can drive `/debug` as a plain
  message (admin-gated the same way; replies land in-channel since bots cannot send true
  ephemerals).
- `router.ts` - registers `DEBUG_COMMAND_SPEC` with Discord on startup.
- `embed-categories.ts` - the `debug` embed category (footer "Debug", icon `debug.png`,
  accent `#ff80e0`). See [embed-system.md](embed-system.md).
- `discord-api.ts` - `editInteractionContentReply`, used for the raw-text (`echo`) path.

## Using It

Invoke `/debug` in Discord and type the subcommand into the `command` option, for example:

- `/debug` (option omitted) or `/debug help` - prints the help embed listing every
  registered subcommand.
- `/debug echo "hello world"` - replies with the raw text `hello world` as an individual
  message (no embed wrapper).
- `/debug secrettest <secret-value> [secret-name]` - hands this channel's agent a secret
  exactly like `/secret` (written to `/tmp/secrets/<name>` in the box, the agent pointed
  at it via a system reminder), but the value is passed as PLAINTEXT in the command. It is
  a TESTING convenience: because the value is typed into the channel it stays visible in
  the history, so it must only ever carry throwaway test values. For anything real, use
  the `/secret` modal (which keeps the value private). The ack embed loudly flags the
  plaintext exposure. A multi-word value must be quoted. The channel must be registered.

As a plain message (for the tester/automation bot), the same commands work with a leading
`/debug` (or `//debug`), for example `/debug secrettest my-test-value my-name`.

Behavior worth knowing:

- Admin only. Access is gated on admin via `whitelist.isAdmin` (the
  `GatewayContext.isAdmin` closure), NOT on channel ownership, because debug tools inspect
  global state rather than one channel's agent. In production, admin means holding the
  auth-guild admin role (`OPENCLAW_ADMIN_ROLE_ID`); with no role configured, nobody is
  admin (fail closed). `OPENCLAW_ADMIN_OVERRIDE_IDS` is a separate, test/lab-only escape
  hatch: listed ids are accepted unconditionally, before any auth-guild role lookup, for
  rigs whose bot is not a member of the auth server. Do not use the override to grant
  `/debug` in production; add the real role there instead. A non-admin gets the shared
  ephemeral permission-denied embed (`denyInteractionEphemeral` with
  `buildMissingPermissionText`), the same embed every other slash command uses to refuse
  access.
- Every reply is ephemeral (only the invoker sees it), so debug output never leaks into
  the channel.
- Usable anywhere (guild channels, bot DMs, group DMs: `contexts: [0, 1, 2]`) since the
  gate is on the caller's identity, not the surface.
- The input is parsed by a quote-aware tokenizer (`tokenizeDebugCommand`): whitespace
  separates tokens, and single- or double-quoted spans become one token with the quotes
  stripped (so `echo "a b"` echoes `a b`). There is no escape syntax, and an unterminated
  quote runs to the end of the string. The first token (lowercased) is the subcommand; the
  rest are positional arguments.
- An unrecognized subcommand returns a Debug-category "Unknown Subcommand" notice pointing
  at `/debug help`.

## Adding a Subcommand

Subcommands are defined inside `debug-command.ts` and registered in the
`DEBUG_SUBCOMMANDS` array. To add one:

1. Define a `DebugSubcommand` with:
   - `name` - the lowercase token matched against the first parsed word (for example
     `"sessions"`).
   - `usage` - the signature shown (backtick-wrapped) as the help field name (for example
     `"sessions <channel-id>"`).
   - `description` - the one-line help field value. Keep it a single sentence.
   - `run(ctx)` - receives `{ args, subcommands }` and returns a `DebugResult`.
2. Add it to `DEBUG_SUBCOMMANDS`. `help` auto-lists every entry alphabetically, so there
   is nothing else to wire up for it to appear.
3. Return the right `DebugResult` kind:
   - `{ kind: "content", content }` for raw text with no embed (like `echo`). The router
     sends this content unchanged via `editInteractionContentReply`, which also clears any
     embeds and components, so the content must be non-empty and clamped to Discord's
     2000-char message limit; otherwise Discord rejects the edit (nothing to show). There
     is no automatic clamp or empty-guard in the dispatcher or sender, so each
     content-producing subcommand enforces both itself: `echo` clamps via the in-module
     `clamp` helper and returns a notice embed instead when given no text.
   - `{ kind: "embeds", embeds, attachments }` for rich output. For a simple one-embed
     notice use the in-module `debugNotice(title, description)` helper, which builds a
     Debug-category embed and returns the result for you.
   - `{ kind: "secret", name, value }` to hand the channel's agent a secret out-of-band
     (the `secrettest` case). The subcommand stays pure and just describes the secret; the
     router adapter (`deliverDebugSecret`) owns the delivery (enqueue a buffered system
     turn with `secret: { name, value }`, exactly like the `/secret` modal) and acks with
     `buildSecretTestReceivedEmbed`. Sanitize the name with `sanitizeSecretName` so it is
     a safe filename.
4. Add tests in `debug-command.test.ts` (the parser/registry is pure and easy to unit
   test). If the subcommand changes the router/gating path, add an integration test to the
   `/debug admin gate` block in `router.events.test.ts`.

The dispatcher (`runDebugCommand`) handles `help` and the empty-input default itself,
looks up the subcommand case-insensitively, and falls back to the unknown-subcommand
notice, so a new subcommand only needs its registry entry plus `run`.

## Limits and Gotchas

- Logging never includes arguments. `debugSubcommandLabel` logs only the caller id plus a
  recognized subcommand name (or `(help)` / `(unknown)`); unrecognized input is never
  echoed, so an admin who pastes a credential as the command does not persist it in the
  router log, and forged newlines cannot inject log lines.
- Help overflow respects two distinct Discord limits: each embed holds at most 25 fields,
  while the combined text of all embeds in the message (title + description + every
  field + footer) must stay under 6000 characters across at most 10 embeds.
  `buildDebugHelpEmbeds` packs fields across embeds accordingly (title/description on the
  first, fields in the middle, footer/timestamp on the last) and appends a truncation note
  field if the registry ever outgrows that budget, so an oversized list still renders
  instead of 400-ing.
- Defer before edit. The handler defers the interaction ephemerally first (the admin check
  can hit the Discord role API and exceed the ~3s window), then edits the original reply
  with embeds (`editInteractionEmbedReply`) or content (`editInteractionContentReply`).
- `isAdmin` is evaluated before the command is dispatched, so a non-admin's subcommand
  never runs.
- There is an admin-gated text-command path (`parseDebugTextCommand`), added so an
  automation/tester bot that cannot invoke slash commands can still drive `/debug`. It
  runs the same `runDebugCommand`, but because a bot cannot send a true ephemeral, its
  replies post in-channel (visible), unlike the ephemeral slash path. A non-admin's
  `/debug ...` text gets the same permission-denied embed. Any `/debug` text (and a
  `/debug` referenced in a reply) is reduced to just its sanitized subcommand label
  (`debugSubcommandLabel`) before it reaches the router log, so neither a `secrettest`
  value nor a credential pasted as an unknown subcommand is ever persisted there (the
  `secrettest` value still stays visible in the channel by design). If reconnect recovery
  finds an unanswered plaintext `secrettest` command (`debugTextCommandHasSecret`), it
  skips it rather than logging or routing the value.
