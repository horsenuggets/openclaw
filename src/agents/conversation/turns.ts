/**
 * turns
 *
 * Pure translation core that maps OpenClaw's free-form conversation (where
 * either side may send several messages in a row — rapid user sends, or
 * proactive/heartbeat agent sends) into the strictly alternating user/assistant
 * turn shape the LLM APIs require.
 *
 * This layer sits ABOVE pi-ai: it produces normalized alternating turns that the
 * wiring layer then stamps into pi-ai `AgentMessage[]`. It intentionally handles
 * only plain-text messages and injected system context here — turns that carry
 * tool calls or thinking blocks must pass through structurally at the wiring
 * layer (re-encoding them as text would destroy tool_use blocks and thinking
 * signatures the API needs), so they are out of scope for this pure core.
 *
 * Everything here is pure (no I/O, no globals, no clock) so the mapping can be
 * exhaustively unit-tested across every role sequence.
 */

/**
 * A single logical message in the free-form conversation.
 * > `from` carries sender attribution for future multi-user support; it is
 *   omitted for the assigned user and the agent. Callers are responsible for
 *   dropping third-party messages (anyone other than the agent or the assigned
 *   user) before they reach this module.
 */
export type ChatMessage = {
  role: "user" | "agent" | "system";
  text: string;
  ts?: number;
  from?: string;
};

/** A collapsed run of consecutive same-role (user|agent) messages. */
export type ChatTurn = {
  role: "user" | "agent";
  messages: ChatMessage[];
};

/**
 * The free-form conversation after collapsing consecutive same-role runs and
 * lifting out system context. `turns` never has two consecutive same-role turns
 * (its first turn may still be "agent"; user-first is enforced later in
 * toWireTurns). `systemText` is the concatenation of every system entry, to be
 * rendered as a leading reminder.
 */
export type StackedConversation = {
  systemText?: string;
  turns: ChatTurn[];
};

/** A provider-ready alternating turn: role + serialized text content. */
export type WireTurn = {
  role: "user" | "assistant";
  content: string;
};

/**
 * Collapse a free-form message list into alternating turns and lift out system
 * entries. Consecutive user (or agent) messages merge into one turn; a system
 * entry is pulled into `systemText` and does NOT break the surrounding run — so
 * `[user, system, user]` collapses to a single two-message user turn.
 */
export function stackConversation(messages: ChatMessage[]): StackedConversation {
  const turns: ChatTurn[] = [];
  const systemParts: string[] = [];

  for (const message of messages) {
    if (message.role === "system") {
      const text = message.text.trim();
      if (text.length > 0) {
        systemParts.push(text);
      }
      continue;
    }
    const last = turns[turns.length - 1];
    if (last && last.role === message.role) {
      last.messages.push(message);
    } else {
      turns.push({ role: message.role, messages: [message] });
    }
  }

  return {
    systemText: systemParts.length > 0 ? systemParts.join("\n\n") : undefined,
    turns,
  };
}

function hasMetadata(message: ChatMessage): boolean {
  return message.ts !== undefined || message.from !== undefined;
}

type StoredMessage = { ts?: number; from?: string; text: string };

function isStoredMessageArray(value: unknown): value is StoredMessage[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (item) => {
        if (typeof item !== "object" || item === null) {
          return false;
        }
        const record = item as Record<string, unknown>;
        return (
          Object.keys(record).every((key) => key === "ts" || key === "from" || key === "text") &&
          typeof record.text === "string" &&
          (record.ts === undefined || typeof record.ts === "number") &&
          (record.from === undefined || typeof record.from === "string")
        );
      },
    )
  );
}

/**
 * True if a plain string, read back by parseTurnContent, would be misread as the
 * JSON array form instead of a plain message — i.e. its own text happens to be a
 * valid stored-message array like `[{"text":"..."}]`. Such a lone message must be
 * stored as JSON (not plain) so the round-trip does not corrupt its content.
 */
function collidesWithStoredForm(text: string): boolean {
  try {
    return isStoredMessageArray(JSON.parse(text));
  } catch {
    return false;
  }
}

/**
 * Serialize a turn's messages to a STORAGE string (this is NOT the wire format;
 * see renderForWire). A lone message with no metadata is stored as its plain
 * text; anything stacked, carrying a timestamp/sender, or whose text would
 * itself be misread as the JSON array form, is stored as a JSON array of
 * {ts?, from?, text} so boundaries and metadata round-trip exactly. Keys are
 * emitted in a fixed order and defined fields preserved (including empty
 * strings), so identical inputs produce byte-identical output. Read it back
 * with parseTurnContent.
 *
 * This JSON must never reach the model — sending it would train the model to
 * reply in JSON. renderForWire produces the natural-language content for the API.
 */
export function serializeTurnContent(messages: ChatMessage[]): string {
  if (
    messages.length === 1 &&
    !hasMetadata(messages[0]) &&
    !collidesWithStoredForm(messages[0].text)
  ) {
    return messages[0].text;
  }
  return JSON.stringify(
    messages.map((message) => ({
      ...(message.ts !== undefined ? { ts: message.ts } : {}),
      ...(message.from !== undefined ? { from: message.from } : {}),
      text: message.text,
    })),
  );
}

/**
 * Read a stored turn content string (from serializeTurnContent) back into
 * messages, attaching the given turn role. Detects the plain-string case (a lone
 * message with no metadata) and fills defaults; otherwise parses the JSON array
 * form. Anything malformed or ambiguous (including plain text that is not our
 * JSON shape) is treated as a single plain message, so this never throws.
 */
export function parseTurnContent(content: string, role: "user" | "agent"): ChatMessage[] {
  try {
    const parsed: unknown = JSON.parse(content);
    if (isStoredMessageArray(parsed)) {
      return parsed.map((item) => ({
        role,
        text: item.text,
        ...(typeof item.ts === "number" ? { ts: item.ts } : {}),
        ...(typeof item.from === "string" ? { from: item.from } : {}),
      }));
    }
  } catch {
    // Not JSON — fall through to the plain-message case.
  }
  return [{ role, text: content }];
}

/**
 * Render a turn's messages into natural-language content for the LLM API. This
 * NEVER emits JSON: passing the JSON storage form to the model would train it to
 * mimic the structure and reply in JSON. A lone message is rendered as its text;
 * stacked messages join with a blank line so consecutive sends read as natural
 * separate paragraphs. (Sender/timestamp rendering for group chats can be added
 * here later without touching storage.)
 */
export function renderForWire(messages: ChatMessage[]): string {
  return messages.map((message) => message.text).join("\n\n");
}

function wrapSystemReminder(systemText: string): string {
  return `<system-reminder>\n${systemText}\n</system-reminder>`;
}

/**
 * Map a stacked conversation to provider-ready alternating turns.
 *
 * Guarantees on the output: turns strictly alternate user/assistant and the
 * first turn (when any exist) is "user" — both hard requirements of the LLM API.
 *
 * System handling: the collected system text is wrapped in `<system-reminder>`
 * and delivered as conversation content (never a role the API lacks). If the
 * first real turn is a user turn, the reminder is prepended INTO it (avoiding a
 * user/user pair); otherwise the reminder becomes its own leading user turn,
 * which also satisfies the user-first requirement for an agent-first
 * (proactive) conversation. When there is no system text and the conversation
 * still starts with an agent turn, a minimal bootstrap user turn is prepended.
 */
export function toWireTurns(
  conversation: StackedConversation,
  opts?: { bootstrapText?: string },
): WireTurn[] {
  const { systemText, turns } = conversation;
  const reminder = systemText ? wrapSystemReminder(systemText) : undefined;
  const wire: WireTurn[] = [];

  let startIndex = 0;
  if (reminder !== undefined) {
    if (turns[0]?.role === "user") {
      wire.push({
        role: "user",
        content: `${reminder}\n\n${renderForWire(turns[0].messages)}`,
      });
      startIndex = 1;
    } else {
      wire.push({ role: "user", content: reminder });
    }
  }

  for (let i = startIndex; i < turns.length; i += 1) {
    const turn = turns[i];
    wire.push({
      role: turn.role === "agent" ? "assistant" : "user",
      content: renderForWire(turn.messages),
    });
  }

  // Enforce user-first when no reminder led and the conversation opens on an
  // agent (proactive) turn.
  if (reminder === undefined && wire[0]?.role === "assistant") {
    wire.unshift({ role: "user", content: opts?.bootstrapText ?? "(conversation start)" });
  }

  return wire;
}
