---
summary: "What the OpenClaw system prompt contains and how it is assembled"
read_when:
  - Editing system prompt text, tools list, or the Runtime section
  - Changing workspace bootstrap or skills injection behavior
title: "System Prompt"
---

# System Prompt

OpenClaw builds a custom system prompt for every agent run. The prompt is
**OpenClaw-owned** and does not use the p-coding-agent default prompt.

The prompt is assembled by OpenClaw and injected into each agent run.

## Structure

The prompt is intentionally compact and uses fixed sections. The ported sections are
written in the lowercase house style that mirrors the `SYSTEM.md` template source:

- **tooling**: current tool list + short descriptions.
- **tool call style**: how to narrate and acknowledge before running tools.
- **safety**: short guardrail reminder to avoid power-seeking behavior or bypassing
  oversight.
- **skills** (when available): tells the model how to load skill instructions on demand.
- **OpenClaw Self-Update**: how to run `config.apply` and `update.run`.
- **workspace**: working directory (`agents.defaults.workspace`).
- **documentation**: local path to OpenClaw docs (repo or npm package) and when to read
  them.
- **workspace files (injected)**: indicates bootstrap files are included below.
- **Sandbox** (when enabled): indicates sandboxed runtime, sandbox paths, and whether
  elevated exec is available.
- **reply tags**: optional reply tag syntax for supported providers.
- **messaging** + **silent replies**: routing, the `message` tool, and the `⁘ return`
  silent-reply convention.
- **message priority** / **output boundaries**: how to prioritize the incoming message and
  never fabricate user turns.
- **Runtime**: a JSON block of runtime facts (agent id, host, OS, node, model, channel,
  capabilities, thinking level, reasoning level; only present fields are emitted). The
  `agent` field is how the session-logs skill locates `~/.openclaw/agents/<agentId>/`.

The base identity line (`actually, you are openclaw...`) is still emitted as the first
line of every full and `none`-mode prompt. What was removed are the separate **User
Identity** (owner numbers), **Current Date & Time**, and **Heartbeats** sections, plus the
**Writing Style** and CLI quick-reference blocks: owner/identity and workspace context now
come from the injected AGENTS.md / SOUL.md preamble, the current time from
`session_status`, and the heartbeat ack instruction from the separately injected heartbeat
prompt.

Safety guardrails in the system prompt are advisory. They guide model behavior but do not
enforce policy. Use tool policy, exec approvals, sandboxing, and channel allowlists for
hard enforcement; operators can disable these by design.

## Prompt modes

OpenClaw can render smaller system prompts for sub-agents. The runtime sets a `promptMode`
for each run (not a user-facing config):

- `full` (default): includes all sections above.
- `minimal`: used for sub-agents; omits **skills**, **Memory Recall**, **OpenClaw
  Self-Update**, **Model Aliases**, **reply tags**, **messaging**, and **silent replies**.
  **tooling**, **safety**, **workspace**, **Sandbox**, **Runtime**, and injected context
  stay available.
- `none`: returns only the base identity line.

When `promptMode=minimal`, extra injected prompts are labeled **Subagent Context** instead
of **Group Chat Context**.

## Workspace bootstrap injection

Bootstrap files are trimmed and appended under **Project Context** so the model sees
identity and profile context without needing explicit reads:

- `AGENTS.md`
- `SOUL.md`
- `TOOLS.md`
- `IDENTITY.md` (only when `agents.defaults.identityFile` is `true`; off by default)
- `USER.md`
- `HEARTBEAT.md`
- `BOOTSTRAP.md` (only on brand-new workspaces)

`IDENTITY.md` is omitted by default because `SOUL.md` already carries identity; set
`agents.defaults.identityFile: true` to inject it. Large files are truncated with a
marker. The max per-file size is controlled by `agents.defaults.bootstrapMaxChars`
(default: 20000). Missing files inject a short missing-file marker.

Internal hooks can intercept this step via `agent:bootstrap` to mutate or replace the
injected bootstrap files (for example swapping `SOUL.md` for an alternate persona).

To inspect how much each injected file contributes (raw vs injected, truncation, plus tool
schema overhead), use `/context list` or `/context detail`. See
[Context](/concepts/context).

## Time handling

The system prompt does not include the current date/time (this keeps the prompt
cache-stable). When a user timezone is configured, the prompt only adds a one-line hint
telling the model to run `session_status` for the current date, time, or day of week; the
status card includes a timestamp line.

Configure with:

- `agents.defaults.userTimezone`
- `agents.defaults.timeFormat` (`auto` | `12` | `24`)

See [Date & Time](/date-time) for full behavior details.

## Skills

When eligible skills exist, OpenClaw injects a compact **available skills list**
(`formatSkillsForPrompt`) that includes the **file path** for each skill. The prompt
instructs the model to use `read` to load the SKILL.md at the listed location (workspace,
managed, or bundled). If no skills are eligible, the Skills section is omitted.

```
<available_skills>
  <skill>
    <name>...</name>
    <description>...</description>
    <location>...</location>
  </skill>
</available_skills>
```

This keeps the base prompt small while still enabling targeted skill usage.

## Documentation

When available, the system prompt includes a **documentation** section that points to the
local OpenClaw docs directory (either `docs/` in the repo workspace or the bundled npm
package docs) and also notes the source repo and ClawHub (https://clawhub.com) for skills
discovery. The prompt instructs the model to consult local docs first for OpenClaw
behavior, commands, configuration, or architecture, and to run `openclaw status` itself
when possible (asking the user only when it lacks access).
