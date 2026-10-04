/**
 * The only bot-authored channel messages that are NOT replies to a user message:
 * the health-monitor sidecar's lifecycle banners (gated behind the per-instance
 * `lifecycleMessages` preference). Recovery skips exactly these so it can find a
 * genuinely-unanswered user message beneath them. Every OTHER bot message —
 * including error replies like "*Something went wrong...*" — means the user's
 * message was already handled and must NOT be skipped; otherwise recovery
 * re-runs the same failing message on every reconnect (an endless error loop).
 *
 * Banners are posted as Log-category embeds, so the italicized phrase lives in
 * the embed description. The exact-phrase match is what keeps error log embeds
 * (which share the Log category but carry different text) from being skipped.
 */
export const LIFECYCLE_BANNERS = ["*Back online.*", "*Shutting down...*"];

/** A fetched message, narrowed to the fields that can carry a lifecycle banner. */
export type LifecycleBannerMessage = {
  content?: string;
  embeds?: Array<{ description?: string }>;
};

export function isLifecycleBanner(message: string | LifecycleBannerMessage | undefined): boolean {
  if (message == null) {
    return false;
  }
  if (typeof message === "string") {
    return LIFECYCLE_BANNERS.includes(message.trim());
  }
  if (message.content && LIFECYCLE_BANNERS.includes(message.content.trim())) {
    return true;
  }
  return (message.embeds ?? []).some((embed) =>
    LIFECYCLE_BANNERS.includes((embed.description ?? "").trim()),
  );
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
