# heartbeats

How proactive, agent-initiated messaging works in this fork. Heartbeats are the single
proactive mechanism: the old standalone `ProactiveService` and its
`OPENCLAW_SKIP_PROACTIVE` flag have been removed. The surviving system is
`src/infra/heartbeat-runner.ts`, driven by a `HEARTBEAT.md` workspace file.

## How it runs

- Enablement is gated by `OPENCLAW_SKIP_HEARTBEATS` (set to `1` to disable), read once at
  module load, plus a runtime `setHeartbeatsEnabled` and a per-agent
  `isHeartbeatEnabledForAgent`.
- The interval comes from `agents.defaults.heartbeat.every` (default `30m`), parsed by
  `resolveHeartbeatIntervalMs`. Each tick runs the agent in a dedicated `heartbeat`
  session, so heartbeat reasoning never contaminates the user's session.

## The silence ack

Non-exec heartbeats always get `HEARTBEAT_ACK_INSTRUCTION` appended (via
`appendHeartbeatAck`): an idle tick must reply with exactly the silent-reply token, which
is then suppressed so the user sees nothing. Exec-completion ticks use `EXEC_EVENT_PROMPT`
instead. There is also defense-in-depth suppression of the ack pattern in the output.

This is a real behavioral constraint: with low thinking and a low-context heartbeat the
model tends to return the silent token every cycle even when the prompt explicitly asks it
to send something. The ack is unavoidable for non-exec heartbeats, so a proactive check-in
has to overcome that silence bias.

## The delivery-target gap

Delivery resolves through `resolveHeartbeatDeliveryTarget`, which uses the main session's
`lastChannel` and `lastTo`. If the channel is `none` or `lastTo` is empty, the heartbeat
still runs but is dropped with reason `no-target`. This is the known gap for guild
channels: a channel that has no prior inbound message (so no `lastTo`) has nothing to
deliver to, and there is no guild-specific target resolver. On the Docker deployment the
agent box runs with `OPENCLAW_SKIP_CHANNELS=1` and the router posts all outbound, so the
box's session records a channel but often no `to`.

Net: heartbeats fire on schedule and the agent runs each tick, but landing a proactive
check-in in a guild channel still needs both defeating the silence ack and an explicit
delivery target. Raise this gap before declaring proactive messaging "working" for guild
channels.

## Fast-testing heartbeats

There are no `OPENCLAW_HEARTBEAT_*` fast or debug env flags in current code (an old idea
for them never landed; do not rely on memory that says otherwise). The only heartbeat env
flag is `OPENCLAW_SKIP_HEARTBEATS`. To fast-fire for testing, either:

- set a short `agents.defaults.heartbeat.every` (for example `30s`; the duration parser
  supports seconds and has no floor) in the instance config and restart the instance, or
- trigger one immediately with the runtime wake path (`requestHeartbeatNow`,
  `heartbeat-wake.ts`).

Confirm ticks in the box's detailed log (`/tmp/openclaw/openclaw-*.log`), which shows
repeated `embedded run start ... messageChannel=heartbeat`.
