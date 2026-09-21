/**
 * Whitelist gating for privileged router commands.
 *
 * Registration/unregistration is limited to users who hold a specific role in
 * a dedicated "auth" Discord guild. The guild and role ids are supplied via
 * env (OPENCLAW_AUTH_GUILD_ID / OPENCLAW_WHITELIST_ROLE_ID) so no server- or
 * account-specific ids live in the repo. If either is unset the checker fails
 * closed (nobody is whitelisted), so a misconfiguration cannot silently open
 * up provisioning.
 *
 * Results are cached briefly so a burst of commands does not hammer the Discord
 * API; role changes take effect within the TTL.
 */

const DISCORD_API = "https://discord.com/api/v10";
const DISCORD_USER_AGENT = "DiscordBot (https://openclaw.ai, 1.0)";
const CACHE_TTL_MS = 60_000;

export type WhitelistDeps = {
  discordToken: string;
  /** Auth guild id; from OPENCLAW_AUTH_GUILD_ID. Unset => fail closed. */
  guildId: string | undefined;
  /** Whitelisted role id; from OPENCLAW_WHITELIST_ROLE_ID. Unset => fail closed. */
  roleId: string | undefined;
  fetchImpl?: typeof fetch;
  now?: () => number;
  log?: (message: string) => void;
};

export type WhitelistChecker = {
  /** True when the user holds the whitelist role in the auth guild. */
  isWhitelisted: (userId: string) => Promise<boolean>;
  /** True when the guild/role env is configured at all. */
  isConfigured: () => boolean;
};

/**
 * Decide membership from a fetched member's role list. Pure, so it can be
 * unit-tested without the network.
 */
export function memberHasRole(roles: unknown, roleId: string): boolean {
  return Array.isArray(roles) && roles.includes(roleId);
}

export function createWhitelistChecker(deps: WhitelistDeps): WhitelistChecker {
  const doFetch = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;
  const cache = new Map<string, { whitelisted: boolean; at: number }>();

  const isConfigured = () => Boolean(deps.guildId && deps.roleId);

  async function isWhitelisted(userId: string): Promise<boolean> {
    if (!deps.guildId || !deps.roleId) {
      return false; // fail closed
    }
    const cached = cache.get(userId);
    if (cached && now() - cached.at < CACHE_TTL_MS) {
      return cached.whitelisted;
    }

    let whitelisted = false;
    try {
      const resp = await doFetch(`${DISCORD_API}/guilds/${deps.guildId}/members/${userId}`, {
        headers: {
          Authorization: `Bot ${deps.discordToken}`,
          "User-Agent": DISCORD_USER_AGENT,
        },
      });
      if (resp.ok) {
        const member = (await resp.json()) as { roles?: unknown };
        whitelisted = memberHasRole(member.roles, deps.roleId);
      } else if (resp.status !== 404) {
        // 404 = not a member of the auth guild => simply not whitelisted.
        deps.log?.(`[whitelist] member lookup for ${userId} failed (${resp.status})`);
      }
    } catch (err) {
      deps.log?.(`[whitelist] member lookup for ${userId} errored: ${String(err)}`);
    }

    cache.set(userId, { whitelisted, at: now() });
    return whitelisted;
  }

  return { isWhitelisted, isConfigured };
}
