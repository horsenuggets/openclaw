import { SILENT_REPLY_TOKEN } from "../auto-reply/tokens.js";

/**
 * Format a millisecond duration into a human-readable string.
 */
function formatIdleDuration(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) {
    return `${minutes} minute${minutes !== 1 ? "s" : ""}`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const remainingMinutes = minutes % 60;
    if (remainingMinutes === 0) {
      return `${hours} hour${hours !== 1 ? "s" : ""}`;
    }
    return `${hours} hour${hours !== 1 ? "s" : ""} ${remainingMinutes} min`;
  }
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  if (remainingHours === 0) {
    return `${days} day${days !== 1 ? "s" : ""}`;
  }
  return `${days} day${days !== 1 ? "s" : ""} ${remainingHours} hour${remainingHours !== 1 ? "s" : ""}`;
}

export type BuildProactivePromptParams = {
  /** Formatted current time string (e.g. "Monday, Feb 22 at 8:15 AM PST"). */
  formattedTime: string;
  /** Milliseconds since the last user message. */
  userIdleMs: number;
  /** Milliseconds since the last agent response. */
  agentIdleMs: number;
  /** Whether this is a startup greeting check. */
  isStartup?: boolean;
};

/**
 * Build the proactive messaging system prompt injected into a user session.
 * The agent sees this and decides whether to send a natural message or
 * stay silent with NO_REPLY.
 */
export function buildProactivePrompt(params: BuildProactivePromptParams): string {
  const { formattedTime, userIdleMs, agentIdleMs, isStartup } = params;
  const userIdle = formatIdleDuration(userIdleMs);
  const agentIdle = formatIdleDuration(agentIdleMs);

  const lines = [
    `[System: Proactive messaging opportunity]`,
    `Current time: ${formattedTime}`,
    `Last user message: ${userIdle} ago`,
    `Last agent response: ${agentIdle} ago`,
    isStartup ? "Context: The gateway just started up." : "",
    "",
    "You may send a proactive message to the user if you feel",
    "it is appropriate. You have access to the full conversation",
    "history — USE IT. Reference what you actually know about the",
    "user's life, projects, plans, and recent topics. Consider:",
    "- Following up on something specific they mentioned recently",
    "- Asking about the outcome of plans or events they discussed",
    "- Time-appropriate greetings that segue into something relevant",
    "- Sharing a thought or observation connected to prior conversations",
    "- Checking in on something they were working on or struggling with",
    "",
    "Do NOT send generic greetings like 'good morning, how are you?'",
    "without substance. Every message should feel like it comes from",
    "someone who knows and remembers them. Do NOT be formulaic or",
    "robotic. Do NOT repeat the same greetings. If you have nothing",
    "meaningful or specific to say right now,",
    `respond with ONLY: ${SILENT_REPLY_TOKEN}`,
  ];

  return lines.filter(Boolean).join("\n");
}
