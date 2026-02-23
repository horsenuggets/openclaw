import { Type } from "@sinclair/typebox";
import type { MsgContext } from "../../auto-reply/templating.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { MediaAttachment } from "../../media-understanding/types.js";
import type { AnyAgentTool } from "./common.js";
import { loadConfig } from "../../config/config.js";
import {
  buildProviderRegistry,
  createMediaAttachmentCache,
  runCapability,
} from "../../media-understanding/runner.js";
import { readStringParam } from "./common.js";

const TranscribeToolSchema = Type.Object({
  url: Type.String({
    description: "URL or local file path of the audio to transcribe.",
  }),
  language: Type.Optional(
    Type.String({
      description: 'ISO 639-1 language hint (e.g. "en", "es").',
    }),
  ),
});

function isRemoteUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

export function createTranscribeTool(opts?: { config?: OpenClawConfig }): AnyAgentTool {
  return {
    label: "Transcribe",
    name: "transcribe",
    description:
      "Transcribe an audio file or URL to text. Returns the transcript. " +
      "Use this when you receive a voice message attachment or need to " +
      "transcribe any audio.",
    parameters: TranscribeToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const source = readStringParam(params, "url", { required: true });
      const language = readStringParam(params, "language");
      const cfg = opts?.config ?? loadConfig();

      // Build a synthetic attachment so the media pipeline can fetch it.
      // Setting mime to "audio/mpeg" ensures selectAttachments recognizes
      // it as audio; actual MIME is re-detected from bytes during fetch.
      const attachment: MediaAttachment = isRemoteUrl(source)
        ? { url: source, mime: "audio/mpeg", index: 0 }
        : { path: source, mime: "audio/mpeg", index: 0 };

      const cache = createMediaAttachmentCache([attachment]);

      try {
        const audioConfig = cfg.tools?.media?.audio;
        // Merge language hint into config when provided by the caller.
        const configWithLanguage =
          language && audioConfig
            ? { ...audioConfig, language }
            : language
              ? { language }
              : audioConfig;

        const result = await runCapability({
          capability: "audio",
          cfg,
          // Minimal context — scope defaults to "allow" when unset.
          ctx: {} as MsgContext,
          attachments: cache,
          media: [attachment],
          providerRegistry: buildProviderRegistry(),
          config: configWithLanguage,
        });

        const transcriptions = result.outputs.filter((o) => o.kind === "audio.transcription");
        if (transcriptions.length === 0) {
          const reason =
            result.decision.outcome === "disabled"
              ? "Audio transcription is disabled in configuration."
              : "No transcription provider succeeded. Check that an audio " +
                "provider is configured (e.g. OpenAI, Deepgram, Groq).";
          return {
            content: [{ type: "text", text: reason }],
            details: { outcome: result.decision.outcome },
          };
        }

        const transcript = transcriptions.map((t) => t.text).join("\n\n");
        const chosen = transcriptions[0];
        return {
          content: [{ type: "text", text: transcript }],
          details: {
            provider: chosen.provider,
            model: chosen.model,
          },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : "Transcription failed";
        return {
          content: [{ type: "text", text: message }],
          details: { error: message },
        };
      } finally {
        await cache.cleanup();
      }
    },
  };
}
