# Logs and Debugging

Where to look when an agent misbehaves, across the three environments » Production (Docker
on the gateway host), a local single-process gateway, and the local prod-mirror rig. Read
identifiers (channel ids, host) from the running environment; none are hardcoded here.

## Session Transcripts (The Primary Debug Source)

Each agent writes a JSONL transcript per session under
`~/.openclaw/agents/<agentId>/sessions/<sessionId>.jsonl` (session paths are rooted at
`OPENCLAW_STATE_DIR`, which `agent.yml` sets to `/state` in deployed boxes, separate from
`HOME`). Each line is a JSON entry; assistant content blocks are `thinking`, `text`, or
`tool_use`. Useful fields » `stopReason` (`stop` normal, `error` killed or crashed,
`max_tokens`) and `errorMessage` (for example "CLI exited with code 143" is a SIGTERM).
Sort by mtime for the most recent session. Note that a heartbeat turn does not reliably
get its own session » The current runner resolves an unset `heartbeat.session` to the main
session key (see [heartbeats.md](heartbeats.md)), so a heartbeat can appear in the main
transcript. Check `heartbeat.session` and `session.scope` before ruling heartbeat
contamination in or out.

## Structured and Process Logs

- Daily structured log » `/tmp/openclaw/openclaw-YYYY-MM-DD.log`, one JSON object per
  line. Inside a box this is the detailed run log (look for `embedded run start` and
  `messageChannel=heartbeat`).
- A manually started gateway logs to wherever it was redirected (for example
  `/tmp/openclaw-gateway.log` when started with nohup).
- `stream=assistant` events in the logs show generated text (no thinking).

## Reading Logs in Production (Docker)

Prod has no git checkout; everything is a container. Use `docker` on the gateway host...

- Router or health-monitor » `docker logs services.discord-router`.
- A specific channel's agent » `docker logs agents.channel-<id>`, or exec in and read
  `/tmp/openclaw/openclaw-*.log`.
- Confirm a single expected variable reached the router without dumping the whole env
  (which includes `DISCORD_BOT_TOKEN` and `OPENCLAW_PROVISIONER_TOKEN`) »
  `docker inspect services.discord-router --format '{{range .Config.Env}}{{println .}}{{end}}' | grep '^OPENCLAW_MOCK_USER_BOT_ID='`
  (grep for the one variable you care about; note this targets the router container, not
  an agent box).
- Confirm an instance's proxy URLs point at the bridge gateway, not loopback:
  `docker exec agents.channel-<id> sh -lc 'grep -oE "https?://[0-9.]+:[0-9]+" /etc/openclaw/openclaw.json'`.
- Check the model proxy is healthy from inside the box by curling the model-proxy health
  endpoint on the bridge gateway; it should return `{"ok":true}`.

## Reading Logs on the Mirror Rig

The rig is one privileged docker-in-docker box. Reach the inner containers through it, for
example `docker exec openclaw-prod-mirror docker logs agents.channel-<id>`, or use the
`scripts/prod-mirror.sh logs` and `inner` helpers. The full procedure is in
[prod-mirror-e2e-testing.md](prod-mirror-e2e-testing.md).

## Capturing the Exact Anthropic Payload

To debug billing or system-prompt issues, set `OPENCLAW_ANTHROPIC_PAYLOAD_LOG=1` and
`OPENCLAW_ANTHROPIC_PAYLOAD_LOG_FILE=/tmp/openclaw/payload.jsonl` on an agent box. That
captures the exact request payload, which you can replay against the live API to bisect
which system-prompt section causes a problem. See
[auth-and-billing.md](auth-and-billing.md) for the plan-quota versus extra-usage signal.

## Common Debugging Patterns

- Wrong or contaminated response » Check whether a heartbeat ran in the same window;
  confirm the heartbeat uses its own session.
- Thinking text leaked to Discord » Check the reply normalization and streaming
  normalization, and the content block types and `stopReason` in the transcript.
- Message not delivered » Check for inbound dedupe skips and rate-limit retry lines, and
  confirm the delivery path (router versus monitor) and target.
- Model turn fails with "Connection error" in a box » Almost always a stale `127.0.0.1`
  proxy URL; reconcile the instance (see [deployment.md](deployment.md)).
- "Unknown model" » Usually an empty or stale auth store (the subscription catalog is
  auth-gated) or a model id not in this checkout's pi-ai catalog. See
  [auth-and-billing.md](auth-and-billing.md).
