# .agents

Shared, committed context for agents (CoderFish, Claude Code, and humans) working on this
OpenClaw fork. `CLAUDE.md` is a symlink to `AGENTS.md`, and `AGENTS.md` points here for
extra context. Browse this directory directly rather than relying on a listing here; its
contents change over time.

## Layout

- `docs/` - subsystem reference docs: how each part of the fork works, how to test it, and
  the pitfalls we have actually hit. Open the files to see what is covered.

Add new categories as sibling directories when a body of context does not fit the existing
ones, and describe the category here (a folder and a one-line purpose) without enumerating
individual files.

## This repo is public: keep everything generic

`horsenuggets/openclaw` is a public repository, and everything under `.agents/` is tracked
(unlike the old `.claude/*`, which was gitignored except for `docs/`). So treat everything
here as if it were already public:

- No real Discord guild ids, bot or application ids, custom-emoji ids, or tokens.
- No machine or host names, SSH aliases, LAN or public IP addresses.
- No personal absolute paths (for example `/Users/<name>/...` or `C:\Users\<name>\...`).
- Refer to the production host generically as "the gateway host" or "the deploy host (from
  `OPENCLAW_DEPLOY_HOST`)", and read concrete identifiers from env or gitignored files at
  runtime rather than hardcoding them.

Repo-relative code paths (for example `src/discord/router/router.ts`) and generic env var
names are fine and encouraged. Private rig identifiers (lab guild, mirror and mock bot
ids, `.env.mirror` / `.prod-mirror/` contents) stay out of anything committed here; keep
those in your own local notes.

## Keep it current

When you change a subsystem, update the matching context in the same change. These files
are only useful if they track reality, and memory snapshots go stale fast. If a doc and
the code disagree, trust the code and fix the doc.
