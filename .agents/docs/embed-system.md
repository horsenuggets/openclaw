# Embed System

How the Discord router builds, styles, and delivers rich embeds for command responses and
notifications. All of this is under `src/discord/router/`.

## Categories

`embed-categories.ts` defines the embed styling. Every embed belongs to one category, and
the category is the single source of truth for the footer text, default icon filename, and
accent color. The categories are `commandResult`, `connections`, `debug`, `general`,
`log`, `registration`, `secrets`, and `system` (`EMBED_CATEGORIES`). There is no automatic
classifier » Each builder passes its `category` explicitly to `buildEmbed`, which returns
`{ embed, attachments }`, where `attachments` are the icon filenames referenced via
`attachment://`. Command-result embeds additionally pick a state icon (`default` /
`disabled` / `enabled`) via `buildCommandResultEmbed`.

Specific builders » `buildWelcomeEmbed` (`onboarding.ts`), `buildLogEmbed`
(`log-embed.ts`), the `/secret` embeds (`secret-command.ts`), the `/connections` embeds
(`connect-commands.ts`), the `/debug` help and notice embeds (`debug-command.ts`), and the
registration and command-result embeds (`channel-commands.ts`, `gateway-events.ts`).

`buildPaginatedEmbeds` (`embed-pagination.ts`) is the shared multi-embed builder. It
respects two distinct Discord limits, centralized in `embed-limits.ts`: each embed holds
at most 25 fields, 256 chars per field name, 1024 chars per field value, 256 chars of
title, and 4096 chars of description (per-embed caps), while the combined text of all
embeds in the message (title + description + every field name/value + footer) must stay
under 6000 characters (a per-message cap, not per-embed) across at most 10 embeds. Fields
are supplied as ordered GROUPS: every group after the first starts a new embed (a forced
section break), and within a group fields pack onto the current embed until the 25-field
cap and only then spill onto a further embed (the shared 6000-char message budget usually
bites first). The title and description go on the first embed, the footer/icon/timestamp
on the last, every embed shares the category color, and a truncation note is appended only
when the content truly exhausts the 6000-char budget or the 10-embed count (never when the
full payload fits). Every field, the title, the description, and the truncation note are
clamped to their Discord caps, so a caller can never emit a payload Discord rejects.
`chunkLinesIntoFields` is a companion that splits a long single-column list into several
repeated-header fields under the 1024 cap, truncating any single over-long line with an
ellipsis.

`buildSubcommandHelpEmbeds` (`subcommand-fields.ts`) is the shared "subcommand help"
builder: given a category, title (`"<X> Subcommands"`), command name, and subcommand
entries, it sets the title, uses `subcommandHelpDescription(command)` (the shared
`Below are all of the currently-registered subcommands under the \`<command>\`
command...`sentence) as the description, renders one field per entry via`buildSubcommandFields`, and packs via `buildPaginatedEmbeds`. Both `/debug`and`/connections`render their help through it so the structure never diverges.`buildDebugHelpEmbeds` (`debug-command.ts`) delegates to it (alphabetically sorted entries); a bare `/debug`(no subcommand) shows this "Debug Subcommands" help. A bare`/connections`
(no subcommand) shows the parallel "Connections Subcommands" help (the five subcommands
add/available/info/list/remove in authored order).

`listReply` (`connect-commands.ts`) now renders `/connections list` as a SINGLE embed
carrying only the connection data: the title, description, a "Currently Connected"
`connected/total` count, a status "Legend" (one `"Label" -> glyph` line for each of the
three live statuses), and the "Services" list, where each line is `glyph name` (the status
shown by the glyph and decoded by the Legend). The subcommand previews no longer appear
here (they live under a bare `/connections`), so there is no forced second embed; a long
Services list still spills onto further embeds only if it overflows Discord's caps,
chunked under the 1024 cap into several repeated-header Services fields, with a truncation
note appended if the shared message budget is exhausted. Over-long service names are
truncated to 20 chars with an ellipsis. Only services in a live state (linked, re-auth
needed, or a transient ping) appear; coming-soon connectors never do. When nothing is
linked, a single embed shows a friendly note with no subcommand list.

## Icon Assets

`embed-assets.ts` locates the icon directory with `resolveEmbedAssetsDir()`, probing in
order...

1. the `OPENCLAW_EMBED_ASSETS_DIR` env override,
2. `assets/embeds` or `embeds` next to the executable (the compiled-binary case, where
   there is no repo tree in the container), then
3. walking up from the module for the dev and npm cases.

The result is memoized. `readEmbedAsset` reads bytes and guards against path traversal. In
the container, icons must be mounted and found through `OPENCLAW_EMBED_ASSETS_DIR`,
because the router is a compiled binary in a bare image with no source tree.

## Sending and CDN Caching

`sendEmbedMessage` posts to a channel and `editInteractionEmbedReply` patches an
interaction's original reply; both wrap `dispatchEmbed` in `discord-api.ts`. For each icon
an embed references, `dispatchEmbed` either substitutes a cached CDN URL (rewriting
`attachment://` to the CDN URL), uploads the icon as a multipart attachment, or drops the
reference if the file is unreadable. After an upload, the returned CDN URLs are cached
with an expiry. The upload response's `attachments` array does list the uploaded icons »
`cacheUploadedIcons` reads each attachment's filename and URL from it to populate the CDN
cache. The Discord client may not render a consumed icon as a separate visible attachment
(it is referenced by the embed footer or thumbnail via `attachment://`), but the API array
itself is not empty, so do not expect it to be when debugging the cache.

## Application Emojis

`app-emojis.ts` resolves the bot's own application emojis by name at runtime rather than
hardcoding ids. `fetchAppEmojiMap(token)` first resolves the concrete application id via
`/oauth2/applications/@me` (the emoji endpoint rejects the `@me` shortcut), then fetches
`/applications/<appId>/emojis` and returns a name-to-id map (empty on any failure, with a
timeout). `connectionEmojiFromMap` builds status glyphs from emoji names, each with a
unicode fallback.

Resolving by name matters because a bot can use its own application emojis in any guild it
is in, but the same emoji has a different id per application. So an embed posted by one
bot must use that bot's ids. Hardcoding ids would render as literal `:name:` text when a
different bot posts. Never hardcode emoji ids in these docs or in code; resolve by name.

## Delivery Paths and Chunking

Both delivery paths share the chunker `chunkDiscordTextWithMode` (`src/discord/chunk.ts`),
which keeps fenced code blocks balanced and rebalances inline markers. The difference is
the mode » The router path (`route-message.ts`) hardcodes `chunkMode: "newline"` with a
2000-char limit and splits on paragraph boundaries, then `discordSend` paces against the
Discord rate limit, returning only on a 2xx and honoring `retry-after`. The monitor path
(`monitor/reply-delivery.ts`) takes `chunkMode` from params (default `length`). So a
config `chunkMode` affects only the monitor path; the real bots run the router path.

## Pitfalls

- App-emoji ids differ per bot; always resolve by name. When a named emoji is missing the
  code falls back to unicode.
- Icon resolution degrades silently » A missing or unreadable icon is dropped, so a
  missing assets directory yields embeds with no icons rather than an error. Verify
  `OPENCLAW_EMBED_ASSETS_DIR` and the mount on prod.
- Only `buildLogEmbed` truncates to Discord's 4096-char description limit; other builders
  do not, so overly long descriptions can 400.
- Long link-button URLs » Discord caps link-button (style 5) URLs at 512 chars (for
  example a Google OAuth URL with many scopes can exceed it). This is a Discord
  constraint, not enforced in our code; prefer an in-embed markdown link for long URLs.
