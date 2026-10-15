import { timingSafeEqual } from "node:crypto";

/**
 * Authorization for the container proxy's send endpoint.
 *
 * Every agent box can reach the shared proxy over the agent bridge, and the
 * proxy sends with the router's bot token, so without a check any box could make
 * the bot post into another user's channel or DM an arbitrary user. Each box
 * holds its own per-instance `gateway.auth.token`; it presents that token, and we
 * map it back to the caller's channel and then require the destination to belong
 * to that caller: a channel send must target the caller's own channel, and a DM
 * send must target the caller's registered owner.
 */

export type ProxySendAuthzInput = {
  /** The caller-presented per-instance token (from the proxy auth header). */
  callerToken?: string;
  /** Destination channel id for a direct channel send, if any. */
  channelId?: string;
  /** Destination user id for a DM send, if any. */
  userId?: string;
  /** channelId -> that instance's gateway.auth.token, for all registered instances. */
  tokensByChannel: ReadonlyMap<string, string | undefined>;
  /** Resolve the registered owner user id for a channel, if known. */
  resolveOwner: (channelId: string) => string | undefined;
};

export type ProxySendAuthzResult =
  | { ok: true; callerChannel: string }
  | { ok: false; reason: string };

function tokensMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  // timingSafeEqual throws on length mismatch, so gate on length first. The
  // early length check is not itself constant-time, but token length is not
  // secret; the value comparison that matters stays constant-time.
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

export function authorizeProxySend(input: ProxySendAuthzInput): ProxySendAuthzResult {
  const token = input.callerToken?.trim();
  if (!token) {
    return { ok: false, reason: "missing proxy auth token" };
  }
  let callerChannel: string | undefined;
  for (const [channelId, instanceToken] of input.tokensByChannel) {
    if (instanceToken && tokensMatch(instanceToken, token)) {
      callerChannel = channelId;
      break;
    }
  }
  if (!callerChannel) {
    return { ok: false, reason: "unrecognized proxy auth token" };
  }
  const channelId = input.channelId?.trim();
  if (channelId) {
    return channelId === callerChannel
      ? { ok: true, callerChannel }
      : { ok: false, reason: "channel send must target the caller's own channel" };
  }
  const userId = input.userId?.trim();
  if (userId) {
    const owner = input.resolveOwner(callerChannel);
    return owner && userId === owner
      ? { ok: true, callerChannel }
      : { ok: false, reason: "DM send must target the caller's owner" };
  }
  return { ok: false, reason: "no destination" };
}
