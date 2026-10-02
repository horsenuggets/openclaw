import { SILENT_REPLY_TOKEN } from "../../auto-reply/tokens.js";
import { truncateUtf16Safe } from "../../utils.js";

type DeliveryPayload = {
  text?: string;
  mediaUrl?: string;
  mediaUrls?: string[];
};

export function pickSummaryFromOutput(text: string | undefined) {
  const clean = (text ?? "").trim();
  if (!clean) {
    return undefined;
  }
  const limit = 2000;
  return clean.length > limit ? `${truncateUtf16Safe(clean, limit)}…` : clean;
}

export function pickSummaryFromPayloads(payloads: Array<{ text?: string | undefined }>) {
  for (let i = payloads.length - 1; i >= 0; i--) {
    const summary = pickSummaryFromOutput(payloads[i]?.text);
    if (summary) {
      return summary;
    }
  }
  return undefined;
}

export function pickLastNonEmptyTextFromPayloads(payloads: Array<{ text?: string | undefined }>) {
  for (let i = payloads.length - 1; i >= 0; i--) {
    const clean = (payloads[i]?.text ?? "").trim();
    if (clean) {
      return clean;
    }
  }
  return undefined;
}

/**
 * Clear the text of any payload whose text carries the silent-reply token (keeping its media)
 * and drop payloads that end up with neither text nor media. Isolated cron bypasses
 * `normalizeReplyPayload`, and `deliverOutboundPayloads`' directive parser only strips an edge
 * token, so token-bearing text must be cleared here (contains-based, matching the universal
 * contract) before it reaches delivery — even when a sibling payload is deliverable or the
 * token-bearing payload also has media.
 */
export function sanitizeHeartbeatDeliveryPayloads<T extends DeliveryPayload>(payloads: T[]): T[] {
  return payloads.flatMap((payload) => {
    const hasMedia = (payload.mediaUrls?.length ?? 0) > 0 || Boolean(payload.mediaUrl);
    const text = payload.text?.trim();
    const isSilent = !text || text.includes(SILENT_REPLY_TOKEN);
    if (!isSilent) {
      return [payload];
    }
    return hasMedia ? [{ ...payload, text: undefined }] : [];
  });
}

/**
 * Check if a response has no deliverable content after silent-token sanitization.
 * Returns true if delivery should be skipped because nothing real remains.
 */
export function isHeartbeatOnlyResponse(payloads: DeliveryPayload[]) {
  return sanitizeHeartbeatDeliveryPayloads(payloads).length === 0;
}
