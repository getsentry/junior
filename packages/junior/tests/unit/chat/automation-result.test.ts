import { describe, expect, it } from "vitest";
import {
  finishedRunReply,
  remindMissingAutomationResult,
  runDispatchOutcome,
  type AutomationResult,
} from "@/chat/automation-result";
import type { PiMessage } from "@/chat/pi/messages";
import { buildTurnResult } from "@/chat/services/turn-result";
import { createFinishAutomationRunTool } from "@/chat/tools/runtime/finish-automation-run";

const executionProfile = {
  profile: "standard",
  reasoningLevel: "medium" as const,
  reason: "test",
};

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

function declared(result: AutomationResult): PiMessage {
  return {
    role: "toolResult",
    toolCallId: "tool-1",
    toolName: "finishAutomationRun",
    isError: false,
    content: [{ type: "text", text: JSON.stringify(result) }],
    details: result,
    timestamp: 2,
  };
}

function automationTurnResult(args: {
  newMessages: PiMessage[];
  piMessages?: PiMessage[];
}) {
  return buildTurnResult({
    ...args,
    userInput: "Post the weekly digest.",
    toolCalls: [],
    generatedFileCount: 0,
    shouldTrace: false,
    modelId: "test-model",
    executionProfile,
    requireAutomationResult: true,
  });
}

function finish(sendsMessage: boolean, input: Record<string, unknown>) {
  const tool = createFinishAutomationRunTool({ sendsMessage });
  return tool.execute!(tool.prepareArguments!(input), {});
}

describe("automation run result", () => {
  it("reminds a run that stopped without a declared result", () => {
    const draft = assistantStop("Here is the weekly digest.");

    const reminded = remindMissingAutomationResult([draft]);

    expect(reminded).toHaveLength(2);
    expect(reminded?.at(-1)).toMatchObject({ role: "user" });
    expect(
      remindMissingAutomationResult([
        declared({ result: "no_action", reason: "Nothing changed." }),
        assistantStop("Done."),
      ]),
    ).toBeUndefined();
  });

  it("fails a run that ends without a declared result and ignores its text", () => {
    const result = automationTurnResult({
      newMessages: [assistantStop("Here is the weekly digest.")],
    });

    expect(result.text).toBe("");
    expect(result.diagnostics.outcome).toBe("execution_failure");
    expect(runDispatchOutcome(result)).toEqual({
      errorMessage: "Automation run ended without a declared result.",
      outcome: "failed",
    });
  });

  it("keeps a result that an earlier slice saved when a later slice errs", () => {
    const saved = declared({ result: "send_message", message: "The digest." });

    const result = automationTurnResult({
      newMessages: [
        assistant({
          stopReason: "error",
          errorMessage: "Model provider quota exhausted",
        }),
      ],
      piMessages: [saved],
    });

    expect(result.diagnostics.outcome).toBe("success");
    expect(result.text).toBe("The digest.");
  });

  it.each([
    {
      result: { result: "send_message", message: "The digest." } as const,
      posted: "The digest.",
      dispatch: { outcome: "completed" },
    },
    {
      result: { result: "no_action", reason: "Nothing changed." } as const,
      posted: undefined,
      dispatch: { outcome: "completed" },
    },
    {
      result: {
        result: "misconfigured",
        reason: "The release repository was archived.",
      } as const,
      posted: undefined,
      dispatch: {
        errorMessage: "The release repository was archived.",
        outcome: "blocked",
      },
    },
  ])(
    "maps a declared $result.result to its post and dispatch outcome",
    ({ result, posted, dispatch }) => {
      const turn = automationTurnResult({ newMessages: [declared(result)] });

      expect(
        finishedRunReply(turn, {
          declaresResult: true,
          outcomes: [{ action: "send_message" }],
        }),
      ).toBe(posted);
      expect(runDispatchOutcome(turn)).toEqual(dispatch);
    },
  );

  it("posts a failure reply for a chat Turn but not for an automation run", () => {
    const failed = {
      diagnostics: { outcome: "provider_error" },
      text: "I ran into an internal error.",
    };

    expect(finishedRunReply(failed, undefined)).toBe(failed.text);
    expect(finishedRunReply(failed, { declaresResult: true })).toBeUndefined();
  });
});

describe("finishAutomationRun", () => {
  it("saves a message that is only the no-reply marker as no_action", async () => {
    await expect(
      finish(true, { result: "send_message", message: "[[NO_REPLY]]" }),
    ).resolves.toMatchObject({ result: "no_action" });
  });

  it("rejects a result without its message or reason", async () => {
    await expect(
      finish(true, { result: "send_message" }),
    ).rejects.toMatchObject({ name: "ToolInputError" });
    await expect(finish(true, { result: "no_action" })).rejects.toMatchObject({
      name: "ToolInputError",
    });
  });

  it("offers send_message only when the automation has a message outcome", () => {
    const inputSchema = (sendsMessage: boolean) =>
      JSON.stringify(
        createFinishAutomationRunTool({ sendsMessage }).inputSchema,
      );

    expect(inputSchema(true)).toContain("send_message");
    expect(inputSchema(false)).not.toContain("send_message");
  });
});
