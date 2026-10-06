/**
 * The only bot-authored channel messages that are NOT replies to a user message:
 * the health-monitor sidecar's lifecycle banners (gated behind the per-instance
 * `lifecycleMessages` preference). Recovery skips exactly these so it can find a
 * genuinely-unanswered user message beneath them. Every OTHER bot message —
 * including error replies like "*Something went wrong...*" — means the user's
 * message was already handled and must NOT be skipped; otherwise recovery
 * re-runs the same failing message on every reconnect (an endless error loop).
 *
 * Banners are posted as Log-category embeds (no forced italics), so the phrase
 * lives verbatim in the embed description. Current banners lead with a static
 * phrase followed by a JSON diagnostics block, so they match by prefix; the
 * legacy exact phrases are kept for banners still in channel history from older
 * builds. Both forms are distinctive enough that error log embeds (which share
 * the Log category but carry different text) are never skipped.
 */
export const LIFECYCLE_BANNERS = ["Back online.", "Shutting down..."];

/**
 * Lead phrases for current diagnostics banners (see
 * discord-health-monitor/lifecycle-message.ts LIFECYCLE_LEAD). A banner is this
 * lead phrase followed by its JSON payload; the lead alone is not enough to match
 * (see matchesBanner), so an ordinary reply that merely opens with the phrase is
 * not treated as lifecycle noise.
 */
export const LIFECYCLE_BANNER_PREFIXES = [
  "The agent is starting up...",
  "The agent is shutting down...",
];

/** A fetched message, narrowed to the fields that can carry a lifecycle banner. */
export type LifecycleBannerMessage = {
  content?: string;
  embeds?: Array<{ description?: string }>;
};

/**
 * The payload after a banner's lead phrase: the whole remainder as compact JSON, or
 * the body of a ```json fence that spans the entire remainder (the exact shape
 * buildLogEmbed emits). Returns null for anything else — notably a fence with a
 * different label or trailing text after the close, so an ordinary reply that embeds
 * a valid-looking block mid-message is not mistaken for a banner.
 */
function extractBannerPayload(rest: string): string | null {
  const trimmed = rest.trim();
  if (trimmed.startsWith("```")) {
    const fenced = trimmed.match(/^```json\n([\s\S]*)\n```$/);
    return fenced ? fenced[1].trim() : null;
  }
  return trimmed.startsWith("{") ? trimmed : null;
}

/** Whether `text` parses to a JSON object (not an array or primitive). */
function isJsonObject(text: string): boolean {
  try {
    const parsed = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

/**
 * Match a banner phrase, tolerating the legacy italic content form
 * (`*Back online.*`) by stripping surrounding asterisks. Legacy banners are matched
 * exactly (old italic ones normalize via the asterisk strip); current banners must
 * be a lead phrase followed by a payload that actually parses as a JSON object.
 */
function matchesBanner(text: string): boolean {
  const normalized = text
    .trim()
    .replace(/^\*+|\*+$/g, "")
    .trim();
  if (LIFECYCLE_BANNERS.includes(normalized)) {
    return true;
  }
  // Current banners are "<lead> <JSON>" (compact, before embedding) or
  // "<lead>\n```json ...``` " (the fenced form buildLogEmbed produces). Require BOTH the
  // lead phrase AND a payload that parses as a JSON object: matching the lead (or any
  // fenced block) alone would treat an ordinary bot reply that merely opens with the
  // phrase as lifecycle noise and let recovery replay the user message beneath it.
  return LIFECYCLE_BANNER_PREFIXES.some((lead) => {
    if (!normalized.startsWith(lead)) {
      return false;
    }
    const payload = extractBannerPayload(normalized.slice(lead.length));
    return payload != null && isJsonObject(payload);
  });
}

export function isLifecycleBanner(message: string | LifecycleBannerMessage | undefined): boolean {
  if (message == null) {
    return false;
  }
  if (typeof message === "string") {
    return matchesBanner(message);
  }
  if (message.content && matchesBanner(message.content)) {
    return true;
  }
  return (message.embeds ?? []).some((embed) => matchesBanner(embed.description ?? ""));
}

/**
 * Whether a bot's message may be treated as a normal conversational turn.
 * Trusted only when the author is in the allowlist AND is not the router's own
 * bot — routing our own replies back into the agent would be an unbounded
 * self-loop, so self is always rejected even if it was accidentally allowlisted.
 * Shared by the live message filter and the reconnect recovery scan so the two
 * cannot drift.
 */
export function isConversationalBot(
  authorId: string | undefined,
  selfBotId: string | undefined,
  allowedBotIds: Set<string>,
): boolean {
  if (!authorId || authorId === selfBotId) {
    return false;
  }
  return allowedBotIds.has(authorId);
}

export type RouterErrorKind = "connection-refused" | "auth" | "timeout" | "generic";

/**
 * Classify an error thrown while routing a message to an agent container so the
 * router can respond appropriately. Auth/config failures (missing key, expired
 * or rotated OAuth token) are admin problems, NOT something the user can fix by
 * retrying, so they are surfaced as "auth" (logged, not echoed to the user as a
 * generic "try again") rather than falling through to "generic".
 */
export function classifyRouterError(errMsg: string): RouterErrorKind {
  if (errMsg.includes("ECONNREFUSED")) {
    return "connection-refused";
  }
  if (
    errMsg.includes("unauthorized") ||
    errMsg.includes("token_mismatch") ||
    errMsg.includes("pairing") ||
    errMsg.includes("No API key") ||
    errMsg.includes("invalid_grant") ||
    errMsg.includes("OAuth token refresh failed") ||
    errMsg.includes("re-authenticate")
  ) {
    return "auth";
  }
  if (errMsg.includes("timeout") || errMsg.includes("ETIMEDOUT")) {
    return "timeout";
  }
  return "generic";
}

/**
 * Detect raw JS/system errors that leaked into agent output.
 * These are tool execution errors that got captured as response text
 * instead of being handled internally.
 */
export function isLeakedError(text: string): boolean {
  if (!text) {
    return false;
  }
  const t = text.trim();
  // Common JS error patterns that should never appear in user-facing text
  return (
    /^Cannot read propert(y|ies) of (undefined|null)/.test(t) ||
    t.startsWith("TypeError:") ||
    t.startsWith("ReferenceError:") ||
    t.startsWith("SyntaxError:") ||
    t.startsWith("RangeError:") ||
    /^Error: (ENOENT|EACCES|EPERM|ECONNREFUSED)/.test(t) ||
    /^Command exited with code \d+/.test(t) ||
    t.startsWith("[tools] exec failed:") ||
    /^at\s+\S+\s+\(.*:\d+:\d+\)/.test(t)
  );
}
