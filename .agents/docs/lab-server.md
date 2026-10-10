# OpenClaw Lab Server and `scripts/lab`

The **OpenClaw Lab** Discord server is the dedicated place for manual, isolated end-to-end
testing. `scripts/lab/` manages it: it creates numbered testing threads and keeps the
archive tidy, talking to the Lab guild as the **OpenClaw Mirror** bot (never the
production bot, never a real server).

This doc is committed and public, so it names no real guild, bot, or channel ids. The
scripts read all concrete ids from the environment at runtime.

## Server Layout

Categories (depth 1), channels (depth 2), threads (depth 3):

```
General          # untouched by the scripts (#general, #assets)
Testing          # one text channel per day: YYYY-MM-DD
  2026-10-09     #   threads: 0001-some-scenario, 0002-another, ...
  2026-10-08
  ...
Sandbox          # longer-lived channels; can be registered; not auto-archived
Archive 0001     # archived channels, 50 per category, spilling into
Archive 0002     #   Archive 0002, 0003, ... as needed
...
```

- **Testing** holds a text channel per day (named `YYYY-MM-DD` in local time). Each day's
  channel holds one thread per scenario, numbered `0001-...`, `0002-...` (zero-padded to
  4, continuing naturally past `9999`). Testing channels cannot be registered; only
  Testing threads can.
- **Sandbox** is for scenarios that need to persist. Sandbox channels can be registered
  and are not auto-archived. Create them by hand.
- **Archive NNNN** categories hold archived channels. Discord caps a category at 50
  channels, so the archive spills into sequential `Archive NNNN` categories. The scripts
  keep each category filled to 50 before creating the next and never leave an empty one.

## Setup

The scripts read two values and fail loudly if either is missing; they never fall back to
the production bot or server:

- `OPENCLAW_MIRROR_DISCORD_TOKEN` - the OpenClaw Mirror bot token. The mirror overlay
  convention stores it as `DISCORD_BOT_TOKEN` in the gitignored `.env.mirror`, which the
  wrapper maps across (and rejects a value equal to the production `DISCORD_BOT_TOKEN`).
- `OPENCLAW_LAB_GUILD_ID` - the OpenClaw Lab server id, set in `.env.mirror` (see
  `.env.template`).

The `.sh` wrappers source `.env` then `.env.mirror`. A caller-exported
`OPENCLAW_MIRROR_DISCORD_TOKEN` is preserved and wins over the env files; other values
(including `OPENCLAW_LAB_GUILD_ID`) are taken from the env files, so set the guild id in
`.env.mirror` rather than expecting a command-line override to stick.

Auto-adding members to new threads additionally needs the Mirror bot's **Server Members**
privileged intent (enabled in the Discord developer portal). Without it the add is skipped
with a warning and the thread is still created.

## Scripts

Each script is a thin `.sh` wrapper that loads the Lab env and runs a `bun` TypeScript
entrypoint. Pure logic (name sanitization, numbering, archive bin-packing, the member
filter) lives in `lab-core.ts` and is unit-tested in `lab-core.test.ts`; the archive
repacking is tested in `archives.test.ts`; Discord I/O lives in `discord.ts`.

- `create_new_thread.sh <title> [description] [--no-members]` - the main entry point.
  Creates today's `YYYY-MM-DD` Testing channel on demand (with its intro embed), then a
  sequentially numbered `NNNN-<slug>` thread with a confirmation embed. The title is
  slugified (lowercase, punctuation runs collapsed to `-`, trimmed, capped at 32 chars)
  and a description over 1000 chars is rejected before any Discord work. Expired Testing
  days are archived first. By default every non-bot Lab member is added to the new thread
  so all testers see it; pass `--no-members` to skip that.
- `archive_old_threads.sh` - moves Testing day channels (and their threads) older than 7
  days into the archive categories. `create_new_thread.sh` runs this automatically, so it
  rarely needs to be run by hand.
- `archive_channel.sh <channel-id>` - archives one channel (must exist and not be a
  category), then tidies.
- `tidy_archives.sh` - repacks every archived channel into contiguous `Archive NNNN`
  categories of up to 50. Each channel moves straight to its destination; a move that
  would momentarily exceed the 50-channel ceiling is deferred and retried once another
  move frees a slot, so a channel is never left parentless. Runs automatically whenever a
  channel is archived.
- `thanos_snap_archives.sh [--yes]` - deletes a random half of the archived channels, then
  tidies.
- `clear_archives.sh [--yes]` - deletes every archived channel, then tidies (removing the
  now-empty categories).
- `archive_sandbox_channels.sh` - archives every Sandbox channel, then tidies. The empty
  Sandbox category is left in place.

`thanos_snap` and `clear` are irreversible and prompt for confirmation unless `--yes` is
passed (and require `--yes` when there is no interactive terminal).

## Conventions

- "Archive" means move a channel into an `Archive NNNN` category; Discord channels have no
  native archived state.
- Testing channels and threads are archived after 7 days.
- Leave created test threads and channels in place as evidence; the scripts archive them
  on their own schedule.
