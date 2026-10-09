# Repository Guidelines

This file collects the working conventions for the OpenClaw repo » Project layout, build
and test commands, coding style, the commit and PR flow, and a large set of agent-specific
operational notes. Read it before making changes.

- Repo → https://github.com/horsenuggets/openclaw
- For extra context, read whatever is in `.agents/` (also reachable via the `.claude/`
  symlink). Its contents change over time, so browse it directly rather than relying on a
  list here. `.agents/docs/` holds subsystem references (architecture, commands, embeds,
  deployment, logs, heartbeats, system prompt, auth and billing, sandbox, testing); start
  at `.agents/docs/README.md`.
- Keep `.agents/docs/` current as the work evolves. When you change a subsystem, update
  its doc in the same change; if a doc and the code disagree, trust the code and fix the
  doc. This repo is public and everything under `.agents/` is tracked, so keep the docs
  generic » No real Discord guild, bot, application, or emoji ids, no tokens, no machine
  or host names, no IP addresses, and no personal absolute paths. Read concrete
  identifiers from env or gitignored files at runtime.

## Project Structure and Module Organization

- Source code lives in `src/` » CLI wiring in `src/cli/`, commands in `src/commands/`, the
  web provider in `src/provider-web.ts`, infrastructure in `src/infra/`, and the media
  pipeline in `src/media/`.
- Tests are colocated as `*.test.ts`.
- Documentation lives in `docs/` (images, queue, Pi config), and built output lands in
  `dist/`.
- Plugins and extensions live under `extensions/*` as workspace packages. Keep plugin-only
  dependencies in the extension `package.json`, and do not add them to the root
  `package.json` unless core uses them.
- When a plugin installs, it runs `npm install --omit=dev` in the plugin directory, so
  runtime dependencies must live in `dependencies`. Avoid `workspace:*` in `dependencies`
  because npm install breaks on it; put `openclaw` in `devDependencies` or
  `peerDependencies` instead, since the runtime resolves `openclaw/plugin-sdk` via the
  jiti alias.
- Installers served from `https://openclaw.ai/*` live in the sibling repo
  `../openclaw.ai/` (`public/install.sh`, `public/install-cli.sh`, `public/install.ps1`).
- When refactoring shared logic (routing, allowlists, pairing, command gating, onboarding,
  docs), always consider every built-in and extension channel. Core channel docs are in
  `docs/channels/`; core channel code is in `src/telegram/`, `src/discord/`, `src/slack/`,
  `src/signal/`, `src/imessage/`, `src/web/` (WhatsApp web), `src/channels/`, and
  `src/routing/`; channel plugins are extensions under `extensions/*` (for example
  `extensions/discord/`, `extensions/telegram/`, `extensions/slack/`).
- When adding channels, extensions, apps, or docs, review `.github/labeler.yml` for label
  coverage.

## Docs Linking (Mintlify)

- Docs are hosted on Mintlify at docs.openclaw.ai.
- Internal doc links in `docs/**/*.md` are root-relative with no `.md` or `.mdx` suffix,
  for example `[Config](/configuration)`.
- Section cross-references use anchors on root-relative paths, for example
  `[Hooks](/configuration#hooks)`.
- Avoid em dashes and apostrophes in doc headings and anchors because they break Mintlify
  anchor links.
- When Peter asks for links, reply with full `https://docs.openclaw.ai/...` URLs rather
  than root-relative paths.
- When you touch docs, end the reply with the `https://docs.openclaw.ai/...` URLs you
  referenced.
- In the GitHub README, keep absolute docs URLs (`https://docs.openclaw.ai/...`) so the
  links work on GitHub.
- Keep docs content generic, with no personal device names, hostnames, or paths; use
  placeholders like `user@gateway-host` and "gateway host".

## Docs i18n (zh-CN)

- `docs/zh-CN/**` is generated, so do not edit it unless the user explicitly asks.
- The pipeline is to update the English docs first, adjust the glossary
  (`docs/.i18n/glossary.zh-CN.json`), run `scripts/docs-i18n`, and apply targeted fixes
  only if instructed.
- The translation memory is `docs/.i18n/zh-CN.tm.jsonl` (generated).
- See `docs/.i18n/README.md` for details.
- The pipeline can be slow and inefficient; if it is dragging, ping @jospalmbier on
  Discord instead of hacking around it.

## exe.dev VM Ops (General)

- The stable access path is `ssh exe.dev` followed by `ssh vm-name`, assuming the SSH key
  is already set.
- When SSH is flaky, use the exe.dev web terminal or Shelley (the web agent), and keep a
  tmux session for long operations.
- Update with `sudo npm i -g openclaw@latest`; the global install needs root on
  `/usr/lib/node_modules/`.
- Configure with `openclaw config set ...`, and make sure `gateway.mode=local` is set.
- For Discord, store the raw token only, with no `DISCORD_BOT_TOKEN=` prefix.
- To restart, stop the old gateway and run:
  `pkill -9 -f openclaw-gateway || true; nohup openclaw gateway run --bind loopback --port 18789 --force > /tmp/openclaw-gateway.log 2>&1 &`
- Verify with `openclaw channels status --probe`, `ss -ltnp | rg 18789`, and
  `tail -n 120 /tmp/openclaw-gateway.log`.

## Build, Test, and Development Commands

- The runtime baseline is Node 22+; keep both the Node and Bun paths working.
- Install dependencies with `pnpm install`.
- Install the pre-commit hooks with `prek install`; they run the same checks as CI.
- `bun install` is also supported; keep `pnpm-lock.yaml` and Bun patching in sync when
  touching dependencies or patches.
- Prefer Bun for TypeScript execution in scripts, dev, and tests » `bun <file.ts>` or
  `bunx <tool>`.
- Run the CLI in dev with `pnpm openclaw ...` (Bun) or `pnpm dev`.
- Node remains supported for running built output (`dist/*`) and production installs.
- For Mac packaging in dev, `scripts/package-mac-app.sh` defaults to the current arch, and
  the release checklist is `docs/platforms/mac/release.md`.
- Type-check and build with `pnpm build`.
- Run TypeScript checks with `pnpm tsgo`.
- Lint and format with `pnpm check`.
- Run tests with `pnpm test` (Vitest), and get coverage with `pnpm test:coverage`.

## Coding Style and Naming Conventions

- The language is TypeScript (ESM); prefer strict typing and avoid `any`.
- Formatting and linting go through Oxlint and Oxfmt; run `pnpm check` before commits.
- Add brief code comments for tricky or non-obvious logic.
- Keep files concise and extract helpers instead of making "V2" copies. Use the existing
  patterns for CLI options and dependency injection via `createDefaultDeps`.
- Aim to keep files under about 700 LOC; this is a guideline, not a hard guardrail, so
  split or refactor when it improves clarity or testability.
- Use "OpenClaw" for the product, app, and docs headings, and `openclaw` for the CLI
  command, the package and binary, paths, and config keys.

## Release Channels (Naming)

- stable covers tagged releases only (for example `vYYYY.M.D`), under the npm dist-tag
  `latest`.
- beta covers prerelease tags (`vYYYY.M.D-beta.N`) under the npm dist-tag `beta`, and may
  ship without the macOS app.
- dev is the moving head on `main`, with no tag; check out `main` to get it.

## Testing Guidelines

- The framework is Vitest with V8 coverage thresholds of 70% for lines, branches,
  functions, and statements.
- Name tests to match their source with `*.test.ts`, and name e2e tests `*.e2e.test.ts`.
- Run `pnpm test` (or `pnpm test:coverage`) before pushing whenever you touch logic.
- Do not set test workers above 16; that has already been tried.
- Live tests with real keys run as `CLAWDBOT_LIVE_TEST=1 pnpm test:live` (OpenClaw-only)
  or `LIVE=1 pnpm test:live` (includes provider live tests). The Docker variants are
  `pnpm test:docker:live-models` and `pnpm test:docker:live-gateway`, and the onboarding
  Docker E2E is `pnpm test:docker:onboard`.
- The full kit and what it covers is in `docs/testing.md`.
- Pure test additions or fixes generally do not need a changelog entry unless they alter
  user-facing behavior or the user asks for one.
- On mobile, check for connected real devices (iOS and Android) before using a simulator,
  and prefer them when available.
- Prefer unit tests over live gateway testing. Most changes can be verified with
  `npx vitest run <file>` and `pnpm build`. Do not start the full gateway, watchdog, or a
  Discord connection unless the user explicitly asks for live testing; use mocks for
  Discord API calls, CLI invocations, and external services.
- For isolated gateway testing, `openclaw gateway run --isolated` creates a throwaway
  environment (temp state dir, auto-picked port, no channels, loopback-only). Use
  `--port <N>` for a specific port, and send test messages with
  `openclaw agent --message "..." --port <port>`. Multiple isolated instances can run at
  once; see `docs/testing.md` for details.
- For live persona or behavior e2e on the prod-mirror rig, confirm an agent-visible change
  (persona and `SOUL.md`, onboarding, routing, command gating) in a real Discord channel
  before merging by using `scripts/prod-mirror.sh` against the OpenClaw Lab test server.
  The full procedure (setup, deploying branch code, the mock-user driver pattern, gotchas)
  lives in `.claude/docs/prod-mirror-e2e-testing.md` (tracked). The real lab guild and bot
  ids stay out of that doc; read them from the gitignored `.env.mirror` and
  `.prod-mirror/box.env` at runtime.
- Never leave gateway processes running. If you do start a gateway or watchdog for
  testing, you must stop it before finishing your task by running `pnpm gateway:killall`.
- For gateway process management, `pnpm gateway:ps` lists all running OpenClaw gateway and
  watchdog processes across the OS, and `pnpm gateway:killall` kills them all (SIGTERM
  then SIGKILL).
- Discord E2E tests (`src/discord/e2e/*.e2e.test.ts`) hit real Discord and require two
  bots » A test bot driven by the test code and the Claw bot running as a gateway. The
  steps are:
  1. Start the gateway with Discord channels enabled (do not use `gateway:dev`, which sets
     `OPENCLAW_SKIP_CHANNELS=1`) by running `node dist/entry.js gateway --force` after
     building with `pnpm build`. The Discord bot token is read from
     `~/.openclaw/openclaw.json`.
  2. Set the `OPENCLAW_MOCK_USER_BOT_TOKEN` environment variable to the mock-user (test
     driver) bot's token.
  3. Run the tests with
     `LIVE=1 npx vitest run --config vitest.e2e.config.ts src/discord/e2e/<file>`, using
     `-t "test name"` to run a single test.
  4. After testing, always run `pnpm gateway:killall`.
- The visual E2E verify cycle for formatting and chunking changes is:
  1. `pnpm build`.
  2. `node dist/entry.js gateway --force &`.
  3. `LIVE=1 npx vitest run --config vitest.e2e.config.ts src/discord/e2e/visual-formatting.e2e.test.ts`.
  4. Review every screenshot in `src/discord/e2e/screenshots/` for orphaned continuation
     text, broken bold spans, mid-sentence splits, and formatting discontinuities.
  5. `pnpm gateway:killall`.
  6. Fix issues and repeat from step 1 until there are zero errors.

## Commit and Pull Request Guidelines

- Create commits with `scripts/committer "<msg>" <file...>` and avoid manual `git add` or
  `git commit` so staging stays scoped.
- Write concise, action-oriented commit messages, for example
  `CLI: add verbose flag to send`.
- Group related changes and avoid bundling unrelated refactors.
- For the changelog workflow, keep the latest released version at the top with no
  `Unreleased` section; after publishing, bump the version and start a new top section.
- PRs should summarize their scope, note the testing performed, and mention any
  user-facing changes or new flags.
- When given a PR link to review, review it via `gh pr view` and `gh pr diff`, and do not
  change branches.
- For PR review calls, prefer a single `gh pr view --json ...` to batch metadata and
  comments, and run `gh pr diff` only when needed.
- Before starting a review when a GitHub issue or PR is pasted, run `git pull`; if there
  are local changes or unpushed commits, stop and alert the user before reviewing.
- The goal is to merge PRs » Prefer rebase when the commits are clean, and squash when the
  history is messy.
- The PR merge flow is to create a temp branch from `main` and merge the PR branch into it
  (prefer squash unless the commit history matters, in which case use rebase or merge).
  Always try to merge the PR unless it is truly difficult, in which case use another
  approach. If you squash, add the PR author as a co-contributor. Apply fixes, add a
  changelog entry (including the PR number and thanks), run the full gate before the final
  commit, commit, merge back to `main`, delete the temp branch, and end on `main`.
- If you review a PR and later do work on it, land it via merge or squash with no
  direct-main commits, and always add the PR author as a co-contributor.
- When working on a PR, add a changelog entry with the PR number and thank the
  contributor.
- When working on an issue, reference the issue in the changelog entry.
- When merging a PR, leave a PR comment that explains exactly what was done and includes
  the SHA hashes.
- When merging a PR from a new contributor, add their avatar to the README "Thanks to all
  clawtributors" thumbnail list.
- After merging a PR, run `bun scripts/update-clawtributors.ts` if the contributor is
  missing, then commit the regenerated README.

## Shorthand Commands

- `sync` » If the working tree is dirty, commit all changes with a sensible Conventional
  Commit message, then run `git pull --rebase`; if the rebase conflicts and cannot be
  resolved, stop, otherwise `git push`.

### PR Workflow (Review vs Land)

- In review mode (PR link only), read `gh pr view` and `gh pr diff`, do not switch
  branches, and do not change code.
- In landing mode, create an integration branch from `main`, bring in the PR commits
  (prefer rebase for linear history, though a merge is allowed when complexity or
  conflicts make it safer), apply fixes, add a changelog entry (with thanks and the PR
  number), run the full gate locally before committing
  (`pnpm build && pnpm check && pnpm test`), commit, merge back to `main`, then
  `git switch main` so you never stay on a topic branch after landing. The contributor
  must be in the git graph afterward.

## Security and Configuration Tips

- The web provider stores credentials at `~/.openclaw/credentials/`; rerun
  `openclaw login` if you are logged out.
- Pi sessions live under `~/.openclaw/sessions/` by default, and the base directory is not
  configurable.
- For environment variables, see `~/.profile`.
- Never commit or publish real phone numbers, videos, or live configuration values; use
  obviously fake placeholders in docs, tests, and examples.
- For the release flow, always read `docs/reference/RELEASING.md` and
  `docs/platforms/mac/release.md` before any release work, and do not ask routine
  questions once those docs answer them.

## Troubleshooting

- For rebrand or migration issues, or legacy config and service warnings, run
  `openclaw doctor` (see `docs/gateway/doctor.md`).

## Agent-Specific Notes

- In the project vocabulary, "makeup" means "mac app".
- Never edit `node_modules/`, including global, Homebrew, npm, and git installs, because
  updates overwrite it; put skill notes in `tools.md` or `AGENTS.md` instead.
- Signal "update fly" means running
  `fly ssh console -a flawd-bot -C "bash -lc 'cd /data/clawd/openclaw && git pull --rebase origin main'"`
  and then `fly machines restart e825232f34d058 -a flawd-bot`.
- When working on a GitHub issue or PR, print the full URL at the end of the task.
- When answering questions, give high-confidence answers only » Verify in code and do not
  guess.
- Never update the Carbon dependency.
- Any dependency with `pnpm.patchedDependencies` must use an exact version, with no `^` or
  `~`.
- Patching dependencies (pnpm patches, overrides, or vendored changes) requires explicit
  approval; do not do it by default.
- For CLI progress, use `src/cli/progress.ts` (`osc-progress` plus the `@clack/prompts`
  spinner) rather than hand-rolling spinners or bars.
- For status output, keep the tables and ANSI-safe wrapping in `src/terminal/table.ts`;
  `status --all` is read-only and pasteable, while `status --deep` probes.
- The gateway currently runs only as the menubar app, with no separate LaunchAgent or
  helper label installed. Restart it via the OpenClaw Mac app or `scripts/restart-mac.sh`,
  and to verify or kill it use `launchctl print gui/$UID | grep openclaw` rather than
  assuming a fixed label. When debugging on macOS, start and stop the gateway via the app
  rather than ad-hoc tmux sessions, and kill any temporary tunnels before handoff.
- For macOS logs, use `./scripts/clawlog.sh` to query the unified logs for the OpenClaw
  subsystem; it supports follow, tail, and category filters, and expects passwordless sudo
  for `/usr/bin/log`.
- If shared guardrails are available locally, review them; otherwise follow this repo's
  guidance.
- For SwiftUI state management on iOS and macOS, prefer the Observation framework
  (`@Observable`, `@Bindable`) over `ObservableObject` and `@StateObject`; do not
  introduce new `ObservableObject` unless required for compatibility, and migrate existing
  usages when touching related code.
- When adding a connection provider, update every UI surface and the docs (the macOS app,
  the web UI, mobile if applicable, and the onboarding and overview docs) and add matching
  status and configuration forms so the provider lists and settings stay in sync.
- Version locations are » `package.json` (CLI); `apps/android/app/build.gradle.kts`
  (versionName and versionCode); `apps/ios/Sources/Info.plist` and
  `apps/ios/Tests/Info.plist` (CFBundleShortVersionString and CFBundleVersion);
  `apps/macos/Sources/OpenClaw/Resources/Info.plist` (CFBundleShortVersionString and
  CFBundleVersion); `docs/install/updating.md` (pinned npm version);
  `docs/platforms/mac/release.md` (APP_VERSION and APP_BUILD examples); and the Peekaboo
  Xcode projects and Info.plists (MARKETING_VERSION and CURRENT_PROJECT_VERSION).
- "Restart iOS/Android apps" means rebuild (recompile and install) and relaunch, not just
  kill and launch.
- Before testing on devices, verify connected real iOS and Android devices before reaching
  for simulators or emulators.
- To look up the iOS Team ID, run `security find-identity -p codesigning -v` and use the
  Apple Development (...) TEAMID; the fallback is
  `defaults read com.apple.dt.Xcode IDEProvisioningTeamIdentifiers`.
- The A2UI bundle hash at `src/canvas-host/a2ui/.bundle.hash` is auto-generated, so ignore
  unexpected changes and only regenerate it via `pnpm canvas:a2ui:bundle` (or
  `scripts/bundle-a2ui.sh`) when needed; commit the hash as a separate commit.
- Release signing and notary keys are managed outside the repo; follow the internal
  release docs.
- The notary auth env vars (`APP_STORE_CONNECT_ISSUER_ID`, `APP_STORE_CONNECT_KEY_ID`,
  `APP_STORE_CONNECT_API_KEY_P8`) are expected in your environment, per the internal
  release docs.
- Multi-agent safety » Do not create, apply, or drop `git stash` entries unless explicitly
  requested, and this includes `git pull --rebase --autostash`. Assume other agents may be
  working, keep unrelated WIP untouched, and avoid cross-cutting state changes.
- Multi-agent safety » When the user says "push", you may `git pull --rebase` to integrate
  the latest changes, but never discard other agents' work. When the user says "commit",
  scope to your changes only. When the user says "commit all", commit everything in
  grouped chunks.
- Multi-agent safety » Do not switch branches or check out a different branch unless
  explicitly requested.
- Multi-agent safety » Running multiple agents is fine as long as each agent has its own
  session.
- Multi-agent safety » When you see unrecognized files, keep going, focus on your changes,
  and commit only those.
- For lint and format churn » If the staged and unstaged diffs are formatting-only,
  auto-resolve them without asking; if a commit or push was already requested, auto-stage
  and include formatting-only follow-ups in the same commit (or a tiny follow-up commit if
  needed) without extra confirmation; and only ask when the changes are semantic (logic,
  data, or behavior).
- For the lobster seam, use the shared CLI palette in `src/terminal/palette.ts` with no
  hardcoded colors, and apply the palette to onboarding and config prompts and other TTY
  UI output as needed.
- Multi-agent safety » Focus reports on your edits, avoid guard-rail disclaimers unless
  you are truly blocked, continue when multiple agents touch the same file if it is safe,
  and end with a brief "other files present" note only if relevant.
- For bug investigations, read the source code of the relevant npm dependencies and all
  related local code before concluding, aiming for a high-confidence root cause.
- Code style » Add brief comments for tricky logic, and keep files under about 500 LOC
  when feasible, splitting or refactoring as needed.
- Tool schema guardrails (google-antigravity) » Avoid `Type.Union` in tool input schemas,
  and no `anyOf`, `oneOf`, or `allOf`. Use `stringEnum` or `optionalStringEnum` (a
  Type.Unsafe enum) for string lists, and `Type.Optional(...)` instead of `... | null`.
  Keep the top-level tool schema as `type: "object"` with `properties`.
- Tool schema guardrails » Avoid raw `format` property names in tool schemas, since some
  validators treat `format` as a reserved keyword and reject the schema.
- When asked to open a "session" file, open the Pi session logs under
  `~/.openclaw/agents/<agentId>/sessions/*.jsonl` (using the `agent` value in the Runtime
  JSON block of the system prompt, newest unless a specific ID is given), not the default
  `sessions.json`. If logs are needed from another machine, SSH via Tailscale and read the
  same path there.
- Do not rebuild the macOS app over SSH; rebuilds must run directly on the Mac.
- Never send streaming or partial replies to external messaging surfaces (WhatsApp,
  Telegram); deliver only final replies there. Streaming and tool events may still go to
  internal UIs and the control channel.
- Voice wake forwarding » The command template should stay
  `openclaw-mac agent --message "${text}" --thinking low`, since `VoiceWakeForwarder`
  already shell-escapes `${text}`, so do not add extra quotes. The launchd PATH is
  minimal, so make sure the app's launch agent PATH includes the standard system paths
  plus your pnpm bin (typically `$HOME/Library/pnpm/`) so the `pnpm` and `openclaw`
  binaries resolve when invoked via `openclaw-mac`.
- For manual `openclaw message send` messages that include `!`, use the heredoc pattern
  noted elsewhere to avoid the Bash tool's escaping.
- Release guardrails » Do not change version numbers without the operator's explicit
  consent, and always ask permission before running any npm publish or release step.

## NPM and 1Password (Publish/Verify)

- Use the 1Password skill, and run all `op` commands inside a fresh tmux session.
- Sign in with `eval "$(op signin --account my.1password.com)"` (with the app unlocked and
  the integration on).
- Get the OTP with `op read 'op://Private/Npmjs/one-time password?attribute=otp'`.
- Publish with `npm publish --access public --otp="<otp>"`, run from the package
  directory.
- Verify without local npmrc side effects using
  `npm view <pkg> version --userconfig "$(mktemp)"`.
- Kill the tmux session after publishing.
