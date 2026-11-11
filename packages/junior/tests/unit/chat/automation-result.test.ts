import { describe, expect, it } from "vitest";
import { finishedRunReply, runDispatchOutcome } from "@/chat/automation-result";
import { postsRunNotices } from "@/chat/conversations/kind-behavior";
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

const messageOutcome = {
  declaresResult: true,
  outcomes: [{ action: "send_message" }],
};

describe("automation run answer", () => {
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

  it("posts nothing and completes when the Turn ends without an answer", () => {
    const result = gatedTurnResult([assistantStop("Here is the digest.")]);

    expect(finishedRunReply(result, messageOutcome)).toBeUndefined();
    expect(runDispatchOutcome(result)).toEqual({ outcome: "completed" });
  });

  it("keeps an answer when a later slice errs", () => {
    const result = gatedTurnResult([
      answered("reply", { text: "The digest." }),
      assistant({ stopReason: "error", errorMessage: "Quota exhausted" }),
    ]);

    expect(result.diagnostics.outcome).toBe("success");
    expect(finishedRunReply(result, messageOutcome)).toBe("The digest.");
  });

  it.each([
    {
      name: "reply",
      message: answered("reply", { text: "The digest." }),
      posted: "The digest.",
      dispatch: { outcome: "completed" },
    },
    {
      name: "noReply",
      message: answered("noReply", { note: "Nothing changed." }),
      posted: undefined,
      dispatch: { outcome: "completed" },
    },
    {
      name: "reportBlocked",
      message: answered("reportBlocked", {
        missing: "The release repository was archived.",
      }),
      posted: undefined,
      dispatch: {
        errorMessage: "The release repository was archived.",
        outcome: "blocked",
      },
    },
    // A run in progress at deploy can have this result from an earlier slice.
    {
      name: "finishAutomationRun",
      message: answered("finishAutomationRun", {
        result: "send_message",
        message: "The digest.",
      }),
      posted: "The digest.",
      dispatch: { outcome: "completed" },
    },
  ])(
    "maps $name to its post and dispatch outcome",
    ({ message, posted, dispatch }) => {
      const result = gatedTurnResult([
        assistantStop("I checked the queue. Here is the digest."),
        message,
      ]);

      expect(finishedRunReply(result, messageOutcome)).toBe(posted);
      expect(runDispatchOutcome(result)).toEqual(dispatch);
    },
  );

  it("posts a failure reply for a chat Turn but not for an automation run", () => {
    const failed = {
      diagnostics: { outcome: "provider_error" },
      text: "I ran into an internal error.",
    };

    expect(finishedRunReply(failed, undefined)).toBe(failed.text);
    expect(finishedRunReply(failed, { declaresResult: true })).toBeUndefined();
    // Failure replies and notices outside the finished run follow the rule.
    expect(postsRunNotices(undefined)).toBe(true);
    expect(postsRunNotices({ declaresResult: true })).toBe(false);
    expect(postsRunNotices({ outcomes: [] })).toBe(false);
  });
});

describe("reply", () => {
  function call(tool: ReturnType<typeof createReplyTool>, text: string) {
    return tool.execute!(tool.prepareArguments!({ text }), {});
  }

  it("accepts one reply per Turn", async () => {
    const tool = createReplyTool();

    await expect(call(tool, "The digest.")).resolves.toMatchObject({
      text: "The digest.",
    });
    await expect(call(tool, "Another digest.")).rejects.toMatchObject({
      name: "ToolInputError",
    });
  });

  it("rejects an empty reply and the legacy no-reply marker", async () => {
    await expect(call(createReplyTool(), " ")).rejects.toMatchObject({
      name: "ToolInputError",
    });
    await expect(call(createReplyTool(), "[[NO_REPLY]]")).rejects.toMatchObject(
      { name: "ToolInputError" },
    );
  });
});
