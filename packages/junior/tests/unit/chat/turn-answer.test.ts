import { describe, expect, it } from "vitest";
import type { PiMessage } from "@/chat/pi/messages";
import { buildTurnResult } from "@/chat/services/turn-result";
import { createReplyTool } from "@/chat/tools/runtime/reply";
import { readTurnAnswer, remindMissingAnswer } from "@/chat/turn-answer";

function assistant(
  fields:
    | { stopReason: "stop"; text: string }
    | { stopReason: "error"; errorMessage: string },
): PiMessage {
  return {
    role: "assistant",
    api: "test",
    provider: "test",
    model: "test",
    content:
      fields.stopReason === "stop" ? [{ type: "text", text: fields.text }] : [],
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: fields.stopReason,
    ...(fields.stopReason === "error"
      ? { errorMessage: fields.errorMessage }
      : undefined),
    timestamp: 1,
  };
}

function assistantStop(text: string): PiMessage {
  return assistant({ stopReason: "stop", text });
}

function answered(toolName: string, details: unknown): PiMessage {
  return {
    role: "toolResult",
    toolCallId: "tool-1",
    toolName,
    isError: false,
    content: [{ type: "text", text: JSON.stringify(details) }],
    details,
    timestamp: 2,
  } as PiMessage;
}

function gatedTurnResult(newMessages: PiMessage[]) {
  return buildTurnResult({
    newMessages,
    userInput: "Post the weekly digest.",
    toolCalls: [],
    generatedFileCount: 0,
    shouldTrace: false,
    modelId: "test-model",
    reasoningLevel: "medium",
    answer: readTurnAnswer(newMessages) ?? "missing",
  });
}

describe("turn answer", () => {
  it("reminds a Turn that stopped without an answer in this Turn", () => {
    const earlier = answered("reply", { text: "Yesterday's digest." });
    const draft = assistantStop("Here is the weekly digest.");

    expect(remindMissingAnswer([earlier, draft], 1)?.at(-1)).toMatchObject({
      role: "user",
    });
    expect(
      remindMissingAnswer([answered("noReply", {}), assistantStop("Done.")], 0),
    ).toBeUndefined();
  });

  it("keeps an answer when a later slice errs", () => {
    const result = gatedTurnResult([
      answered("reply", { text: "The digest." }),
      assistant({ stopReason: "error", errorMessage: "Quota exhausted" }),
    ]);

    expect(result.diagnostics.outcome).toBe("success");
    expect(result.reply?.text).toBe("The digest.");
  });

  // A run in progress at deploy can have this result from an earlier slice.
  it("reads a finishAutomationRun result as an answer", () => {
    expect(
      readTurnAnswer([
        answered("finishAutomationRun", {
          result: "send_message",
          message: "The digest.",
        }),
      ]),
    ).toEqual({ reply: { text: "The digest.", toolCallId: "tool-1" } });
  });
});

describe("reply", () => {
  function call(text: string) {
    const tool = createReplyTool("automation");
    return tool.execute!(tool.prepareArguments({ text }), {});
  }

  it("rejects an empty reply and the legacy no-reply marker", async () => {
    await expect(call(" ")).rejects.toMatchObject({
      name: "ToolInputError",
    });
    await expect(call("[[NO_REPLY]]")).rejects.toMatchObject({
      name: "ToolInputError",
    });
  });
});
