import { afterEach, describe, expect, it, vi } from "vitest";
import { createTranscribeTool } from "./transcribe-tool.js";

vi.mock("../../media-understanding/runner.js", () => ({
  buildProviderRegistry: vi.fn(() => new Map()),
  createMediaAttachmentCache: vi.fn(() => ({
    cleanup: vi.fn(),
  })),
  runCapability: vi.fn(),
}));

vi.mock("../../config/config.js", () => ({
  loadConfig: vi.fn(() => ({})),
}));

// eslint-disable-next-line @typescript-eslint/consistent-type-imports
const { runCapability, createMediaAttachmentCache } =
  await import("../../media-understanding/runner.js");

afterEach(() => {
  vi.clearAllMocks();
});

describe("createTranscribeTool", () => {
  it("returns a tool with correct name and schema", () => {
    const tool = createTranscribeTool();
    expect(tool.name).toBe("transcribe");
    expect(tool.label).toBe("Transcribe");
    expect(tool.parameters).toBeDefined();
  });

  it("returns transcript text on success", async () => {
    vi.mocked(runCapability).mockResolvedValueOnce({
      outputs: [
        {
          kind: "audio.transcription",
          attachmentIndex: 0,
          text: "Hello world",
          provider: "openai",
          model: "gpt-4o-mini-transcribe",
        },
      ],
      decision: { capability: "audio", outcome: "success", attachments: [] },
    });

    const tool = createTranscribeTool();
    const result = await tool.execute("call-1", {
      url: "https://cdn.example.com/voice.ogg",
    });

    expect(result.content).toEqual([{ type: "text", text: "Hello world" }]);
    expect(result.details).toEqual({
      provider: "openai",
      model: "gpt-4o-mini-transcribe",
    });
  });

  it("constructs a URL-based attachment for remote URLs", async () => {
    vi.mocked(runCapability).mockResolvedValueOnce({
      outputs: [
        {
          kind: "audio.transcription",
          attachmentIndex: 0,
          text: "test",
          provider: "deepgram",
        },
      ],
      decision: { capability: "audio", outcome: "success", attachments: [] },
    });

    const tool = createTranscribeTool();
    await tool.execute("call-1", {
      url: "https://example.com/audio.mp3",
    });

    const call = vi.mocked(runCapability).mock.calls[0][0];
    expect(call.media).toEqual([
      { url: "https://example.com/audio.mp3", mime: "audio/mpeg", index: 0 },
    ]);
  });

  it("constructs a path-based attachment for local files", async () => {
    vi.mocked(runCapability).mockResolvedValueOnce({
      outputs: [
        {
          kind: "audio.transcription",
          attachmentIndex: 0,
          text: "test",
          provider: "groq",
        },
      ],
      decision: { capability: "audio", outcome: "success", attachments: [] },
    });

    const tool = createTranscribeTool();
    await tool.execute("call-1", { url: "/tmp/recording.wav" });

    const call = vi.mocked(runCapability).mock.calls[0][0];
    expect(call.media).toEqual([{ path: "/tmp/recording.wav", mime: "audio/mpeg", index: 0 }]);
  });

  it("passes language hint through to config", async () => {
    vi.mocked(runCapability).mockResolvedValueOnce({
      outputs: [
        {
          kind: "audio.transcription",
          attachmentIndex: 0,
          text: "Hola mundo",
          provider: "openai",
        },
      ],
      decision: { capability: "audio", outcome: "success", attachments: [] },
    });

    const tool = createTranscribeTool({
      config: { tools: { media: { audio: { enabled: true } } } },
    });
    await tool.execute("call-1", {
      url: "https://example.com/voice.ogg",
      language: "es",
    });

    const call = vi.mocked(runCapability).mock.calls[0][0];
    expect(call.config).toEqual({ enabled: true, language: "es" });
  });

  it("returns error message when no providers succeed", async () => {
    vi.mocked(runCapability).mockResolvedValueOnce({
      outputs: [],
      decision: { capability: "audio", outcome: "skipped", attachments: [] },
    });

    const tool = createTranscribeTool();
    const result = await tool.execute("call-1", {
      url: "https://example.com/voice.ogg",
    });

    expect(result.content[0].text).toContain("No transcription provider");
  });

  it("returns disabled message when audio transcription is off", async () => {
    vi.mocked(runCapability).mockResolvedValueOnce({
      outputs: [],
      decision: { capability: "audio", outcome: "disabled", attachments: [] },
    });

    const tool = createTranscribeTool();
    const result = await tool.execute("call-1", {
      url: "https://example.com/voice.ogg",
    });

    expect(result.content[0].text).toContain("disabled");
  });

  it("returns error message on exception", async () => {
    vi.mocked(runCapability).mockRejectedValueOnce(new Error("Network timeout"));

    const tool = createTranscribeTool();
    const result = await tool.execute("call-1", {
      url: "https://example.com/voice.ogg",
    });

    expect(result.content).toEqual([{ type: "text", text: "Network timeout" }]);
    expect(result.details).toEqual({ error: "Network timeout" });
  });

  it("cleans up cache after execution", async () => {
    const cleanup = vi.fn();
    vi.mocked(createMediaAttachmentCache).mockReturnValueOnce({
      cleanup,
    } as never);
    vi.mocked(runCapability).mockResolvedValueOnce({
      outputs: [],
      decision: { capability: "audio", outcome: "skipped", attachments: [] },
    });

    const tool = createTranscribeTool();
    await tool.execute("call-1", { url: "https://example.com/a.ogg" });

    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("cleans up cache even on error", async () => {
    const cleanup = vi.fn();
    vi.mocked(createMediaAttachmentCache).mockReturnValueOnce({
      cleanup,
    } as never);
    vi.mocked(runCapability).mockRejectedValueOnce(new Error("boom"));

    const tool = createTranscribeTool();
    await tool.execute("call-1", { url: "https://example.com/a.ogg" });

    expect(cleanup).toHaveBeenCalledOnce();
  });
});
