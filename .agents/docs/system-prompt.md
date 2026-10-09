# System Prompt and System Reminders

How the embedded system prompt is assembled, and how the subscription path keeps requests
on plan quota by moving OpenClaw content out of the system prompt and into a conversation
reminder. This is tightly coupled to billing; read
[auth-and-billing.md](auth-and-billing.md) alongside it.

## How the Prompt is Built

`buildEmbeddedSystemPrompt` (`src/agents/pi-embedded-runner/system-prompt.ts`) forwards to
`buildAgentSystemPrompt` (`src/agents/system-prompt.ts`). The section prose lives in
`docs/reference/templates/SYSTEM.md`, parsed by `loadSystemPromptSections`;
`renderPromptSection` fills `${...}` tokens and fails loud if a required section is
missing. The builder assembles intro, tooling, tool-call style, safety, skills, memory,
self-update, model aliases, workspace, sandbox, messaging, voice, Project Context, and a
runtime JSON block. A `PromptMode` (`full` / `minimal` / `none`) gates which sections
render.

## The Subscription Prompt Swap

The `anthropic-subscription` provider (OAuth) bills to free plan quota only when the
request looks like Claude Code. Two things make that true...

1. System block 0 is exactly `You are Claude Code, Anthropic's official CLI for Claude.`
   This is added by pi-ai for OAuth tokens, not by our code.
2. The rest of the system prompt must stay consistent with that identity.
   OpenClaw-specific operational content (messaging and routing, heartbeat and proactive
   behavior, persona) reads as a different kind of agent and spills the request to paid
   extra usage.

So on the subscription path the code no longer tries to strip individual sections. (The
old `SUBSCRIPTION_OMIT_HEADINGS` and `stripSection` approach, and the `PROJECT_CONTEXT`
sentinels, are gone or inert.) Instead, `resolveSystemPromptDelivery`
(`src/agents/subscription-prompt.ts`) swaps the entire system block for a lean
`CC_BASE_PROMPT` and hands the full OpenClaw system prompt back as a preamble to ride the
conversation. A request is treated as subscription when the provider is
`anthropic-subscription` or the provider config has `auth: "oauth"`.

## The System-Reminder Persona Preamble

`buildPersonaPreambleMessage` (`src/agents/pi-embedded-runner/persona-preamble.ts`) emits
a leading `role: "user"` message whose text is wrapped in
`<system-reminder>...</system-reminder>`. On the subscription path it leads with the full
OpenClaw system prompt, then persona framing, then workspace files, then an off-file
pointer. The key fact » Conversation content is billing-neutral, so this reaches the model
on every path without spilling. The preamble is built in memory each run, never persisted,
so it survives compaction.

## Per-File Workspace Context

`src/agents/pi-embedded-runner/workspace-context.ts` routes each workspace file to one of
three delivery modes » `inline` (in the system prompt's Project Context), `preamble` (in
the `<system-reminder>` message), or `off` (not sent, only pointed at so the agent can
read it on demand). Precedence is per-file, then a global default, then a built-in
default, then `inline`. Built-in defaults send SOUL, AGENTS, IDENTITY, USER, and BOOTSTRAP
via the preamble (billing-safe on the subscription path, where inline Project Context is
swapped away), and leave TOOLS, HEARTBEAT, and MEMORY off with a pointer.

## Why Onboarding is Conversation, Not System Prompt

First-run onboarding directives (BOOTSTRAP) and persona nudges must reach the model but
must not spill billing, so they are delivered as conversation content (the preamble, or
the router prepending BOOTSTRAP to the user message), never injected into the system
prompt.

## Pitfalls

- Never rely on the truncation cap to keep a spilling section off the wire. A section that
  sits at the prompt tail can start reaching the API when the cap is raised, causing a
  "worked last week" billing regression. Deliver divergent content as conversation
  instead.
- When you add a new system-prompt section, consider the subscription path » If the
  content is OpenClaw-specific, route it through the preamble rather than the system
  prompt, and verify with the billing probe (see
  [auth-and-billing.md](auth-and-billing.md)).
- These behaviors only apply when the provider is `anthropic-subscription` or
  `auth: "oauth"`. Non-subscription providers are unaffected.
