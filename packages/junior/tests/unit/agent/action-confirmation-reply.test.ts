import { describe, expect, it } from "vitest";
import type { PiMessage } from "@/chat/pi/messages";
import { buildActionConfirmationReply } from "@/chat/agent/action-confirmation-reply";
import { getAssistantMessageText } from "@/chat/services/turn-result";

const usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  },
};

function rejectedMessages(): PiMessage[] {
  return [
    {
      role: "assistant",
      api: "test",
      provider: "test",
      model: "test",
      content: [
        {
          type: "toolCall",
          id: "tool-1",
          name: "deleteWorkspace",
          arguments: { workspace: "preview-42" },
        },
      ],
      usage,
      stopReason: "toolUse",
      timestamp: 1,
    },
    {
      role: "toolResult",
      toolCallId: "tool-1",
      toolName: "deleteWorkspace",
      content: [{ type: "text", text: "confirmation required" }],
      isError: true,
      timestamp: 2,
      details: {
        guardianActionRejection: {
          actionKey: "a".repeat(64),
          decision: "ask",
          priorRejection: {
            decision: "ask",
            input: { workspace: "preview-42" },
            reason: "Deletion needs confirmation.",
            tool: {
              description:
                "[workspace-provider] Permanently delete preview-42 and all of its contents.",
              name: "deleteWorkspace",
            },
          },
          reason:
            "User has not confirmed permanently deleting preview-42 and all of its contents.",
          version: 1,
        },
      },
    },
  ] as PiMessage[];
}

describe("action confirmation reply", () => {
  it("builds a direct confirmation when the agent stops after an ask", () => {
    const reply = buildActionConfirmationReply(rejectedMessages());

    expect(reply?.content).toEqual([
      {
        type: "text",
        text: [
          "I haven't performed the action. You have not confirmed permanently deleting preview-42 and all of its contents.",
          "Should I perform that exact action?",
        ].join("\n\n"),
      },
    ]);
    expect(reply && getAssistantMessageText(reply)).toContain(
      "Should I perform that exact action",
    );
  });

  it("does not duplicate a visible reply after the ask", () => {
    const messages = rejectedMessages();
    messages.push({
      role: "assistant",
      api: "test",
      provider: "test",
      model: "test",
      content: [{ type: "text", text: "Should I delete preview-42?" }],
      usage,
      stopReason: "stop",
      timestamp: 3,
    } as PiMessage);

    expect(buildActionConfirmationReply(messages)).toBeUndefined();
  });

  it("does not revive an earlier ask after a later denial", () => {
    const messages = rejectedMessages();
    const denied = structuredClone(messages.at(-1)!);
    if (denied.role !== "toolResult") {
      throw new Error("Expected a tool result fixture");
    }
    denied.details = {
      guardianActionRejection: {
        ...(
          denied.details as {
            guardianActionRejection: Record<string, unknown>;
          }
        ).guardianActionRejection,
        decision: "deny",
      },
    };
    messages.push(denied);

    expect(buildActionConfirmationReply(messages)).toBeUndefined();
  });

  it("does not revive an ask after a later user instruction", () => {
    const messages = rejectedMessages();
    messages.push({
      role: "user",
      content: [{ type: "text", text: "Do something else instead." }],
      timestamp: 3,
    } as PiMessage);

    expect(buildActionConfirmationReply(messages)).toBeUndefined();
  });
});
