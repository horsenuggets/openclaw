import type { RequestClient } from "@buape/carbon";
import fs from "node:fs";
import path from "node:path";
import type { ChunkMode } from "../../auto-reply/chunk.js";
import type { ReplyPayload } from "../../auto-reply/types.js";
import type { MarkdownTableMode } from "../../config/types.base.js";
import type { RuntimeEnv } from "../../runtime.js";
import { convertMarkdownTables } from "../../markdown/tables.js";
import {
  chunkDiscordTextWithMode,
  findUnclosedMarkers,
  stripOrphanedMarkerOutsideCode,
} from "../chunk.js";
import { stripHorizontalRules } from "../markdown-strip.js";
import { sendMessageDiscord } from "../send.js";
import { convertTimesToDiscordTimestamps } from "../timestamps.js";

let _debugBlockIndex = 0;
let _debugChunkIndex = 0;

function debugDump(stage: string, index: number, text: string) {
  const dir = process.env.DISCORD_DEBUG_DUMP;
  if (!dir) return;
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${String(index).padStart(2, "0")}-${stage}.txt`);
  fs.writeFileSync(file, text);
}

export async function deliverDiscordReply(params: {
  replies: ReplyPayload[];
  target: string;
  token: string;
  accountId?: string;
  rest?: RequestClient;
  runtime: RuntimeEnv;
  textLimit: number;
  maxLinesPerMessage?: number;
  replyToId?: string;
  tableMode?: MarkdownTableMode;
  chunkMode?: ChunkMode;
  /** Convert time references to Discord timestamps. Default: true. */
  discordTimestamps?: boolean;
  /**
   * Inline markers left unclosed by the previous block delivery.
   * When block streaming splits a bold span across deliveries,
   * the new block starts with an orphaned closer that needs to
   * be stripped before chunking.
   */
  pendingMarkers?: string[];
}): Promise<string[]> {
  const chunkLimit = Math.min(params.textLimit, 2000);
  let unclosedMarkers: string[] = params.pendingMarkers ?? [];

  for (const payload of params.replies) {
    const mediaList = payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : []);
    let rawText = payload.text ?? "";

    // Strip orphaned closers left by the previous block delivery
    // so bold spans split across streaming blocks render cleanly.
    if (unclosedMarkers.length > 0) {
      for (const marker of unclosedMarkers) {
        rawText = stripOrphanedMarkerOutsideCode(rawText, marker);
      }
    }

    const blockIdx = _debugBlockIndex++;
    debugDump("raw", blockIdx, rawText);

    const tableMode = params.tableMode ?? "code";
    let text = convertMarkdownTables(rawText, tableMode);
    text = stripHorizontalRules(text);
    // Normalize stray whitespace from LLM output. Web UIs absorb
    // these during HTML rendering but Discord shows raw whitespace.
    // 1. Collapse 3+ newlines to a paragraph break.
    // 2. Remove blank lines between consecutive list items
    //    (LLMs occasionally emit \n\n between bullets).
    text = text.replace(/\n{3,}/g, "\n\n");
    text = text.replace(/^([ \t]*[-*][ \t]+.+)\n\n([ \t]*[-*][ \t]+)/gm, "$1\n$2");
    if (params.discordTimestamps !== false) {
      text = convertTimesToDiscordTimestamps(text);
    }

    debugDump("processed", blockIdx, text);

    if (!text && mediaList.length === 0) {
      continue;
    }

    // Determine which markers are unclosed in the processed text
    // BEFORE chunking. The rebalancer closes them within chunks,
    // but the next block delivery needs to know about them to
    // strip the matching orphaned closers.
    unclosedMarkers = text ? findUnclosedMarkers(text) : [];

    const replyTo = params.replyToId?.trim() || undefined;

    if (mediaList.length === 0) {
      let isFirstChunk = true;
      const mode = params.chunkMode ?? "length";
      const chunks = chunkDiscordTextWithMode(text, {
        maxChars: chunkLimit,
        maxLines: params.maxLinesPerMessage,
        chunkMode: mode,
      });
      if (!chunks.length && text) {
        chunks.push(text);
      }
      // The intra-chunk rebalancer skips single-chunk arrays
      // (nothing to rebalance against). During block streaming a
      // single-chunk block can still have unclosed markers from a
      // span that continues into the next block. Close them so the
      // Discord message renders each block independently. For
      // multi-chunk blocks the rebalancer already closes markers
      // in the last chunk, but verify to be safe.
      if (chunks.length > 0) {
        const lastIdx = chunks.length - 1;
        const lastUnclosed = findUnclosedMarkers(chunks[lastIdx]);
        if (lastUnclosed.length > 0) {
          chunks[lastIdx] += [...lastUnclosed].reverse().join("");
        }
      }
      for (const chunk of chunks) {
        const trimmed = chunk.trim();
        if (!trimmed) {
          continue;
        }
        debugDump("chunk", _debugChunkIndex++, trimmed);
        await sendMessageDiscord(params.target, trimmed, {
          token: params.token,
          rest: params.rest,
          accountId: params.accountId,
          replyTo: isFirstChunk ? replyTo : undefined,
          preProcessed: true,
        });
        isFirstChunk = false;
      }
      continue;
    }

    const firstMedia = mediaList[0];
    if (!firstMedia) {
      continue;
    }
    await sendMessageDiscord(params.target, text, {
      token: params.token,
      rest: params.rest,
      mediaUrl: firstMedia,
      accountId: params.accountId,
      replyTo,
    });
    for (const extra of mediaList.slice(1)) {
      await sendMessageDiscord(params.target, "", {
        token: params.token,
        rest: params.rest,
        mediaUrl: extra,
        accountId: params.accountId,
      });
    }
  }

  return unclosedMarkers;
}
