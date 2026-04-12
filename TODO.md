# TODO

- [ ] Archive local ~/.openclaw config from Mac once MSI laptop is confirmed stable (keep session data, identity, memory synced or migrated)
- [ ] Fix A2UI bundle build on Windows (WSL bash uses old Node; need native Windows build or updated WSL Node)
- [ ] Set up auto-update/pull mechanism on MSI so the gateway stays on latest commits
- [ ] Consider using the watchdog on MSI for crash recovery and auto-rebuild (currently using bare schtasks)
- [ ] Fix Discord `/new` slash command to use `interaction.editReply()` instead of sending a separate message via `routeReply()`. Currently defers with "Claw is thinking..." (ephemeral) then sends the "✅ New session started" as a standalone message. Requires threading the Discord interaction object through the channel-agnostic command pipeline in `src/auto-reply/reply/commands-core.ts`.
- [ ] Discord streaming edits: send first sentence immediately, then edit the message every ~500ms with accumulated text as it streams in (instead of typing indicator → full message at the end)
- [ ] Proactive compaction: trigger at ~30 messages instead of waiting for context overflow. Config change in `agents.defaults.compaction`.
- [ ] Give Claw a `read_conversation_history` tool for on-demand history search instead of stuffing all history into every prompt. Infrastructure exists via `memorySearch.sources: ["sessions"]`.
- [ ] Evaluate calling the Claude Code API endpoint directly via HTTP (subscription OAuth, not API key billing) instead of spawning the claude-cli binary. Same Anthropic `/v1/messages` endpoint with `Authorization: Bearer <oauth-token>` + `anthropic-beta: oauth-2025-04-20`. Eliminates all Windows spawn issues (ENAMETOOLONG, .cmd resolution, stdin piping), enables direct SSE streaming, and allows adding `cache_control` for prompt caching. See `~/git/ai/coder` for the exact API contract. The Claude Code system prompt prefix is required by Anthropic's server-side validation for subscription auth — send it as the first system block, then append OpenClaw's actual prompt after it.
