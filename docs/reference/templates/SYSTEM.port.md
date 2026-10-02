---
summary:
  "This is the guide for porting SYSTEM.md edits back into src/agents/system-prompt.ts."
read_when:
  - "Read this when porting SYSTEM.md wording changes into the system prompt builder."
---

# Porting SYSTEM.md Into the Builder

This file explains how to move edits from `SYSTEM.md` back into
`src/agents/system-prompt.ts`. `SYSTEM.md` is the human-editable source of truth for the
prompt's wording. `system-prompt.ts` is the builder that assembles the live prompt at
runtime for every channel. Porting means copying the wording from `SYSTEM.md` into the
matching string literals in the builder, while leaving all of the surrounding code
(interpolation, conditionals, helpers) intact.

## Mental Model

`buildAgentSystemPrompt` pushes each section onto a `lines: string[]` array and returns
`lines.filter(Boolean).join("\n")`. Most `## Heading` blocks in `SYSTEM.md` correspond to
one of those pushed blocks, either inline in the main function or inside a small
`build...Section` helper. Porting a section means finding that block and replacing its
prose strings, and nothing else.

The rule of thumb is simple: edit the words, never the wiring.

`SYSTEM.md` is a subset of the builder, not a mirror. The builder emits several sections
that `SYSTEM.md` does not list (see Builder Only Sections), and `SYSTEM.md` contains one
section that is never emitted into the shared prompt at all (see Control Commands). Keep
both facts in mind so you do not port text into the wrong place or delete code that
`SYSTEM.md` simply does not describe.

## Finding Each Section

Do not rely on line numbers, because they drift as the file changes. Locate a section by
grepping its heading instead.

- `rg -n "## Skills \(mandatory\)" src/agents/system-prompt.ts`

The mapping from `SYSTEM.md` heading to its home in the builder is below. The function
names are stable even when line numbers move.

- `## tooling` maps to inline in `buildAgentSystemPrompt`.
- `## tool call style` maps to inline in `buildAgentSystemPrompt`.
- `## safety` maps to inline in `buildAgentSystemPrompt`.
- `## skills (mandatory)` maps to `buildSkillsSection`. The catalog is injected here, so
  read the Tokens section before touching it.
- `## workspace` maps to inline in `buildAgentSystemPrompt`. The working-directory lines
  interpolate `${params.workspaceDir}`, so read the Tokens section before touching them.
- `## documentation` maps to `buildDocsSection`.
- `## workspace files (injected)` maps to inline in `buildAgentSystemPrompt`.
- `## reply tags` maps to `buildReplyTagsSection`. This is stripped on the subscription
  path, so read Special Cases.
- `## messaging` and `### message tool` map to `buildMessagingSection`. Also stripped on
  the subscription path.
- `## silent replies` maps to inline in `buildAgentSystemPrompt`. It uses the
  `SILENT_REPLY_TOKEN` interpolation, so read the Tokens section before touching it.
- `## message priority` maps to inline in `buildAgentSystemPrompt`.
- `## output boundaries` maps to inline in `buildAgentSystemPrompt`.

`## control commands` has no home in the shared builder on purpose; see Control Commands.

## Control Commands

`SYSTEM.md` contains a `## control commands` section, but it is not emitted into the
shared all-channel builder, so there is nothing to port for it. Those commands (for
example `send_hook_embed`) are Discord-router-only: they are parsed by the Discord router
(the `⁘` marker is `COMMAND_MARKER` in `src/discord/router/agent-commands.ts`) and never
added to `system-prompt.ts`. Keeping Discord-specific commands out of the shared prompt is
deliberate, so do not add a control-command block to the builder when porting.

The one cross-channel convention is the `⁘ return` silent reply. It lives in the Silent
Replies section (inline) via the `SILENT_REPLY_TOKEN` interpolation, and it is handled
runtime-wide by `isSilentReplyText` in `src/auto-reply/tokens.ts`: a host-side no-op on
the Discord router, and a pre-send suppression on every other channel. That token is the
only piece of the control-command world that belongs in the shared prompt.

## Tokens

Two kinds of bracketed tokens appear in `SYSTEM.md`, and they port very differently.

**Interpolated (`${...}`)** are values the builder fills at runtime. Replace the token
with the real TypeScript interpolation and never type a literal value in its place.

- `${skillsCatalog}` maps to the `params.skillsPrompt` slot inside `buildSkillsSection`
  (the `trimmed` array entry). Leave that entry as the injected variable. Do not paste an
  actual catalog.
- `${workspaceDir}` maps to `${params.workspaceDir}` in the inline workspace lines. Leave
  it as the interpolation; do not hardcode a path.
- `⁘ return` in Silent Replies is emitted via the `SILENT_REPLY_TOKEN` constant imported
  from `src/auto-reply/tokens.ts`. Keep the interpolation rather than typing the literal
  marker, so the convention stays in one place.

**Literal (`<...>`)** stay verbatim as plain text in the builder strings, because the
model reads them and they must match real tag names.

- `<available_skills>`, `<description>`, `<location>` stay exactly, because they name the
  tags inside the injected skills catalog.
- `<id>` in `[[reply_to:<id>]]` stays exactly, because it is an instructional placeholder
  the model fills when it emits the tag.

The following are also literal and must stay byte-exact: `[[reply_to_current]]`, every
tool name, and file names like `MEMORY.md`.

## Structure Rules

- **One array element per line.** The builder stores each line of a section as its own
  string and joins them with `\n`. `SYSTEM.md` word-wraps paragraphs for readability, so
  dump the built prompt (see Verification) as the authority on where the real line breaks
  are. Reconstruct the per-line elements, and do not collapse a section into one long
  string.
- **Keep the trailing blank line.** Most blocks end with a `""` element that renders as a
  blank line between sections. Preserve it.
- **Never remove a guard.** Several sections are conditional. For example,
  `buildSkillsSection` returns `[]` when there are no skills, and other sections render
  only when their inputs are present. Edit the strings inside the guard, and leave the
  `if` or ternary alone.

## Casing

`SYSTEM.md` is written in the lowercase house style. Porting it verbatim will make the
live system prompt lowercase too, which is the intent of this exercise. Copy the casing
exactly as written in `SYSTEM.md`, including the lowercased brand names, and keep only the
literal tokens (file names, tag names) in their original case.

## Special Cases

- **Subscription stripping.** `## Reply Tags` and `## Messaging` are removed from the
  prompt on the `anthropic-subscription` path via `SUBSCRIPTION_OMIT_HEADINGS`. That
  constant holds exactly those two headings. If you rename either heading, update
  `SUBSCRIPTION_OMIT_HEADINGS` to match, or the stripping will silently stop working.
- **Builder Only Sections.** The builder emits more sections than `SYSTEM.md` lists,
  including Memory Recall, Voice, Reactions, Model Aliases, Sandbox, Self-Update, Project
  Context, Reasoning Format, Context Recovery, Conversation History, and Group Chat
  Context. Leave those untouched unless you deliberately add them to `SYSTEM.md` first.

## Step by Step

1. Pick one section in `SYSTEM.md` and read its wording.
2. Grep its heading in `system-prompt.ts` to find the matching block.
3. Replace the prose strings with the `SYSTEM.md` wording, preserving every `${...}`
   interpolation, every literal `<...>`, the per-line array structure, and the trailing
   `""`.
4. Leave all conditionals, helpers, and other non-prose code unchanged.
5. Repeat for each section, one at a time.

## Verification

After porting, confirm the real output matches the source.

1. Dump the assembled prompt and eyeball it against `SYSTEM.md`, ignoring interpolated
   values and the injected catalog. A throwaway script under `.local/` (gitignored) is the
   easiest way:

   ```typescript
   import { buildAgentSystemPrompt } from "../src/agents/system-prompt.js";

   console.log(buildAgentSystemPrompt({ workspaceDir: "/home/.openclaw/workspace" }));
   ```

   Run it with `bun .local/dump-prompt.ts` and compare the output section by section.

2. Type-check with `pnpm tsgo`.
3. Lint and format with `pnpm check`.
4. Run the prompt tests with `npx vitest run src/agents/system-prompt.test.ts`. These
   assert on exact prompt strings, so expect failures and update the expected strings to
   the new wording.
5. Sanity-check the subscription path if you touched Reply Tags or Messaging, with
   `npx vitest run src/agents/subscription-prompt.test.ts`.
