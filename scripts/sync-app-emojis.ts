/**
 * Sync application emojis from the prod OpenClaw bot to the mirror bot so both
 * carry the same NAMED set. Application emojis belong to the bot (not a guild),
 * so each bot keeps its own ids; the router resolves them by name at runtime
 * (see src/discord/router/emojis.ts), which is why only the names need to match.
 *
 * Idempotent: for each prod emoji, create it on the mirror when the name is
 * missing, replace it (delete + re-create, since an app-emoji image cannot be
 * PATCHed) only when the image bytes differ, and otherwise leave it alone.
 * Mirror-only emojis (names not on prod) are reported and removed only with
 * --prune.
 *
 * Usage (from repo root, with env loaded):
 *   set -a && . ./.env && set +a
 *   bun scripts/sync-app-emojis.ts [--dry-run] [--prune]
 *
 * Env: DISCORD_BOT_TOKEN (prod, source), OPENCLAW_MIRROR_DISCORD_TOKEN (mirror,
 * target).
 */

const API = "https://discord.com/api/v10";
const CDN = "https://cdn.discordapp.com/emojis";

type Emoji = { id: string; name: string; animated: boolean };

const DRY_RUN = process.argv.includes("--dry-run");
const PRUNE = process.argv.includes("--prune");

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(`Missing env ${name}`);
  }
  return v;
}

type DiscordInit = { method?: string; headers?: Record<string, string>; body?: string };

/** Fetch with one automatic retry on a 429, honouring Discord's retry_after. */
async function discord(url: string, token: string, init: DiscordInit = {}): Promise<Response> {
  const request: RequestInit = {
    method: init.method,
    headers: { Authorization: `Bot ${token}`, ...init.headers },
    body: init.body,
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    const resp = await fetch(url, request);
    if (resp.status !== 429) {
      return resp;
    }
    const body = (await resp.json().catch(() => ({}))) as { retry_after?: number };
    const waitMs = Math.ceil((body.retry_after ?? 1) * 1000) + 250;
    console.log(`  rate limited; waiting ${waitMs}ms`);
    await new Promise((r) => setTimeout(r, waitMs));
  }
  return fetch(url, request);
}

async function appId(token: string): Promise<string> {
  const me = (await (await discord(`${API}/oauth2/applications/@me`, token)).json()) as {
    id?: string;
    name?: string;
  };
  if (!me.id) {
    throw new Error("could not resolve application id");
  }
  return me.id;
}

async function listEmojis(token: string, app: string): Promise<Emoji[]> {
  const body = (await (await discord(`${API}/applications/${app}/emojis`, token)).json()) as {
    items?: Array<{ id: string; name: string; animated?: boolean }>;
  };
  return (body.items ?? []).map((e) => ({ id: e.id, name: e.name, animated: Boolean(e.animated) }));
}

/** Download an emoji's image bytes from the CDN. */
async function imageBytes(e: Emoji): Promise<Buffer> {
  const ext = e.animated ? "gif" : "png";
  const resp = await fetch(`${CDN}/${e.id}.${ext}`);
  if (!resp.ok) {
    throw new Error(`CDN fetch ${e.name} (${e.id}) failed: ${resp.status}`);
  }
  return Buffer.from(await resp.arrayBuffer());
}

async function createEmoji(
  token: string,
  app: string,
  name: string,
  bytes: Buffer,
  animated: boolean,
): Promise<void> {
  const mime = animated ? "image/gif" : "image/png";
  const resp = await discord(`${API}/applications/${app}/emojis`, token, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, image: `data:${mime};base64,${bytes.toString("base64")}` }),
  });
  if (!resp.ok) {
    throw new Error(`create ${name} failed: ${resp.status} ${await resp.text()}`);
  }
}

async function deleteEmoji(token: string, app: string, id: string): Promise<void> {
  const resp = await discord(`${API}/applications/${app}/emojis/${id}`, token, {
    method: "DELETE",
  });
  if (!resp.ok && resp.status !== 404) {
    throw new Error(`delete ${id} failed: ${resp.status}`);
  }
}

async function main(): Promise<void> {
  const srcToken = requireEnv("DISCORD_BOT_TOKEN");
  const dstToken = requireEnv("OPENCLAW_MIRROR_DISCORD_TOKEN");
  const srcApp = await appId(srcToken);
  const dstApp = await appId(dstToken);
  console.log(`source (prod) app ${srcApp} -> target (mirror) app ${dstApp}`);
  if (DRY_RUN) {
    console.log("[dry run] no changes will be made");
  }

  const source = await listEmojis(srcToken, srcApp);
  const target = await listEmojis(dstToken, dstApp);
  const targetByName = new Map(target.map((e) => [e.name, e]));

  let created = 0;
  let replaced = 0;
  let skipped = 0;

  for (const src of source) {
    const existing = targetByName.get(src.name);
    if (!existing) {
      console.log(`+ create ${src.name}`);
      if (!DRY_RUN) {
        await createEmoji(dstToken, dstApp, src.name, await imageBytes(src), src.animated);
        await new Promise((r) => setTimeout(r, 600));
      }
      created++;
      continue;
    }
    const [srcBytes, dstBytes] = await Promise.all([imageBytes(src), imageBytes(existing)]);
    if (srcBytes.equals(dstBytes)) {
      console.log(`= skip ${src.name} (identical)`);
      skipped++;
      continue;
    }
    console.log(`~ replace ${src.name} (image differs)`);
    if (!DRY_RUN) {
      await deleteEmoji(dstToken, dstApp, existing.id);
      await new Promise((r) => setTimeout(r, 600));
      await createEmoji(dstToken, dstApp, src.name, srcBytes, src.animated);
      await new Promise((r) => setTimeout(r, 600));
    }
    replaced++;
  }

  const sourceNames = new Set(source.map((e) => e.name));
  const orphans = target.filter((e) => !sourceNames.has(e.name));
  for (const o of orphans) {
    if (PRUNE) {
      console.log(`- prune ${o.name} (not on prod)`);
      if (!DRY_RUN) {
        await deleteEmoji(dstToken, dstApp, o.id);
        await new Promise((r) => setTimeout(r, 600));
      }
    } else {
      console.log(`? orphan ${o.name} (on mirror, not on prod; use --prune to remove)`);
    }
  }

  console.log(
    `\nDone. created ${created}, replaced ${replaced}, skipped ${skipped}, orphan${orphans.length === 1 ? "" : "s"} ${orphans.length}${PRUNE ? " (pruned)" : ""}.`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
