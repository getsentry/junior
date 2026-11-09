import { describe, expect, it, vi } from "vitest";
import type { PiMessage } from "@/chat/pi/messages";
const ORIGINAL_ENV = { ...process.env };

function user(text: string, timestamp = 1): PiMessage {
  return {
    role: "user",
    content: [{ type: "text", text }],
    timestamp,
  } as PiMessage;
}

function assistant(text: string, timestamp = 1): PiMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-responses",
    provider: "openai",
    model: "test-model",
    usage: {},
    stopReason: "stop",
    timestamp,
  } as PiMessage;
}

// Synthetic images: only the header bytes that hold the pixel size.
function png(width: number, height: number): Buffer {
  const header = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header);
  header.writeUInt32BE(13, 8);
  header.write("IHDR", 12, "latin1");
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  return header;
}

function gif(width: number, height: number): Buffer {
  const header = Buffer.alloc(13);
  header.write("GIF89a", 0, "latin1");
  header.writeUInt16LE(width, 6);
  header.writeUInt16LE(height, 8);
  return header;
}

// A large APP1 segment puts the frame header after the first decoded prefix.
function jpeg(width: number, height: number, metadataBytes = 0): Buffer {
  const app1 = Buffer.alloc(4 + metadataBytes);
  app1.writeUInt16BE(0xffe1, 0);
  app1.writeUInt16BE(2 + metadataBytes, 2);
  const sof = Buffer.alloc(19);
  sof.writeUInt16BE(0xffc0, 0);
  sof.writeUInt16BE(17, 2);
  sof[4] = 8;
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app1, sof]);
}

function webp(chunk: "VP8 " | "VP8L" | "VP8X", width: number, height: number) {
  const header = Buffer.alloc(30);
  header.write("RIFF", 0, "latin1");
  header.write("WEBP", 8, "latin1");
  header.write(chunk, 12, "latin1");
  if (chunk === "VP8 ") {
    header.writeUIntBE(0x9d012a, 23, 3);
    header.writeUInt16LE(width, 26);
    header.writeUInt16LE(height, 28);
  } else if (chunk === "VP8L") {
    header[20] = 0x2f;
    header.writeUInt32LE((width - 1) | ((height - 1) << 14), 21);
  } else {
    header.writeUIntLE(width - 1, 24, 3);
    header.writeUIntLE(height - 1, 27, 3);
  }
  return header;
}

function imageMessage(mimeType: string, bytes: Buffer): PiMessage {
  return {
    ...user(""),
    content: [{ type: "image", data: bytes.toString("base64"), mimeType }],
  } as PiMessage;
}

function textOf(message: PiMessage): string {
  return (
    (message as { content?: Array<{ text?: string }> }).content
      ?.map((part) => part.text ?? "")
      .join("\n") ?? ""
  );
}

describe("context compaction retained messages", () => {
  it("derives automatic trigger size from the model context window", async () => {
    const {
      calculateContextCompactionTargetTokens,
      calculateContextCompactionTriggerTokens,
      calculateContextInputLimitTokens,
    } = await import("@/chat/services/context-budget");

    const miniTrigger = calculateContextCompactionTriggerTokens({
      contextWindow: 400_000,
    });
    expect(miniTrigger).toBe(360_000);
    expect(calculateContextInputLimitTokens({ contextWindow: 400_000 })).toBe(
      380_000,
    );
    expect(calculateContextCompactionTargetTokens(miniTrigger)).toBe(288_000);
    expect(
      calculateContextCompactionTriggerTokens({
        contextWindow: 1_050_000,
      }),
    ).toBe(945_000);
  });

  it("estimates Claude requests at the measured characters per token", async () => {
    const { estimateHistoryTokens, estimateReplacementTokens } =
      await import("@/chat/services/context-compaction");
    const toolResult = {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "bash",
      content: [{ type: "text", text: "x".repeat(1_000) }],
      isError: false,
      timestamp: 3,
    } as PiMessage;
    const messages = [user("u".repeat(1_000)), toolResult];

    expect(estimateReplacementTokens(messages, "openai/gpt-5.4", 10)).toBe(510);
    expect(
      estimateReplacementTokens(messages, "anthropic/claude-opus-4.6", 10),
    ).toBe(960);

    const toolCall = {
      ...assistant("", 2),
      content: [
        { type: "text", text: "a".repeat(100) },
        { type: "thinking", thinking: "t".repeat(200) },
        {
          type: "toolCall",
          id: "call-1",
          name: "bash",
          arguments: { command: "ls" },
        },
      ],
    } as PiMessage;
    // 100 + 200 + "bash" + '{"command":"ls"}' = 320 characters.
    expect(estimateReplacementTokens([toolCall], "openai/gpt-5.4")).toBe(80);
    expect(
      estimateReplacementTokens([toolCall], "anthropic/claude-opus-4.6"),
    ).toBe(128);
    const image = {
      ...user(""),
      content: [
        { type: "text", text: "u".repeat(200) },
        { type: "image", data: "", mimeType: "image/png" },
      ],
    } as PiMessage;
    // 200 + 4,800 per image = 5,000 characters.
    expect(estimateReplacementTokens([image], "openai/gpt-5.4")).toBe(1_250);
    expect(
      estimateReplacementTokens([image], "anthropic/claude-opus-4.6"),
    ).toBe(2_000);

    const measured = {
      ...assistant("done", 2),
      usage: {
        input: 5_000,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 5_000,
      },
    } as PiMessage;
    expect(
      estimateHistoryTokens(
        [user("u".repeat(1_000)), measured, toolResult],
        "anthropic/claude-opus-4.6",
      ),
    ).toBe(5_550);
  });

  it("estimates Claude images from their pixel size", async () => {
    const { estimateReplacementTokens } =
      await import("@/chat/services/context-compaction");
    const tokens = (message: PiMessage, modelId: string) =>
      estimateReplacementTokens([message], modelId);
    const fhd = imageMessage("image/png", png(1920, 1080));
    const photo = imageMessage("image/webp", webp("VP8L", 2000, 1500));
    const portrait = imageMessage("image/webp", webp("VP8X", 1080, 1920));

    // Examples from "Resolution and token cost" in Anthropic's vision docs.
    const highRes = "anthropic/claude-opus-5.5";
    expect(tokens(imageMessage("image/gif", gif(200, 200)), highRes)).toBe(64);
    expect(
      tokens(imageMessage("image/webp", webp("VP8 ", 1000, 1000)), highRes),
    ).toBe(1_296);
    expect(tokens(fhd, highRes)).toBe(2_691);
    expect(tokens(portrait, highRes)).toBe(2_691);
    expect(tokens(photo, highRes)).toBe(3_888);
    expect(
      tokens(imageMessage("image/jpeg", jpeg(3840, 2160, 60_000)), highRes),
    ).toBe(4_784);

    const standard = "anthropic/claude-opus-4.6";
    expect(tokens(fhd, standard)).toBe(1_560);
    expect(tokens(portrait, standard)).toBe(1_560);
    expect(tokens(photo, standard)).toBe(1_564);

    // Other models and unreadable images keep 4,800 characters per image.
    expect(tokens(fhd, "openai/gpt-5.4")).toBe(1_200);
    expect(
      tokens(imageMessage("image/jpeg", Buffer.from("not a jpeg")), highRes),
    ).toBe(1_920);
  });

  it("uses configured model context windows for runtime thresholds", async () => {
    process.env = {
      ...ORIGINAL_ENV,
      AI_MODEL: "openai/gpt-5.4",
      AI_FAST_MODEL: "openai/gpt-5.4-mini",
      AI_MODEL_CONTEXT_WINDOW_TOKENS: "200000",
    };
    vi.resetModules();
    try {
      const {
        calculateContextCompactionTriggerTokens,
        getAgentContextCompactionTriggerTokens,
        getConversationContextCompactionTriggerTokens,
        getModelContextBudget,
      } = await import("@/chat/services/context-budget");
      const { resolveGatewayModel } = await import("@/chat/pi/client");

      expect(getAgentContextCompactionTriggerTokens("openai/gpt-5.4")).toBe(
        180_000,
      );
      expect(getModelContextBudget("openai/gpt-5.4")).toMatchObject({
        contextWindow: 200_000,
      });
      expect(getConversationContextCompactionTriggerTokens()).toBe(
        calculateContextCompactionTriggerTokens({
          ...resolveGatewayModel("openai/gpt-5.4-mini"),
          contextWindow: 200_000,
        }),
      );
    } finally {
      process.env = { ...ORIGINAL_ENV };
      vi.resetModules();
    }
  });

  it("never raises an active model's advertised context window", async () => {
    process.env = {
      ...ORIGINAL_ENV,
      AI_MODEL_CONTEXT_WINDOW_TOKENS: "900000",
    };
    vi.resetModules();
    try {
      const { getModelContextBudget } =
        await import("@/chat/services/context-budget");
      const { resolveGatewayModel } = await import("@/chat/pi/client");
      const model = resolveGatewayModel("anthropic/claude-haiku-4.5");

      expect(getModelContextBudget(model.id).contextWindow).toBe(
        model.contextWindow,
      );
    } finally {
      process.env = { ...ORIGINAL_ENV };
      vi.resetModules();
    }
  });

  it("keeps newest eligible user messages in chronological order", async () => {
    const { selectRetainedUserMessages } =
      await import("@/chat/services/context-compaction");

    const retained = selectRetainedUserMessages(
      [
        user("older message that should not fit", 1),
        user("middle", 2),
        assistant("assistant reply", 3),
        user("<data_base64>raw-payload</data_base64>", 4),
        user("recent", 5),
      ],
      4,
    );

    expect(retained.map(textOf)).toEqual(["middle", "recent"]);
  });

  it("strips stale runtime context before retaining user text", async () => {
    const { selectRetainedUserMessages } =
      await import("@/chat/services/context-compaction");

    const retained = selectRetainedUserMessages([
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "<runtime-turn-context>\nstale\n</runtime-turn-context>",
          },
          { type: "text", text: "actual user request" },
        ],
        timestamp: 1,
      } as PiMessage,
    ]);

    expect(retained.map(textOf)).toEqual(["actual user request"]);
  });

  it("unwraps current instruction markers before retaining user text", async () => {
    const { selectRetainedUserMessages } =
      await import("@/chat/services/context-compaction");

    const retained = selectRetainedUserMessages([
      user(
        "<current-instruction>\nuse &lt;tag&gt; literally\n</current-instruction>",
      ),
    ]);

    expect(retained.map(textOf)).toEqual(["use <tag> literally"]);
  });

  it("unwraps current instruction markers from composite prompt text", async () => {
    const { selectRetainedUserMessages } =
      await import("@/chat/services/context-compaction");

    const retained = selectRetainedUserMessages([
      user(
        [
          "<thread-background>",
          "prior context",
          "</thread-background>",
          "",
          "<current-instruction>",
          "actual follow-up",
          "</current-instruction>",
        ].join("\n"),
      ),
    ]);

    expect(retained.map(textOf)).toEqual(["actual follow-up"]);
  });
});
