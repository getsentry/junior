import type { AssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, expect, it } from "vitest";
import {
  commitMessages,
  openConversationProjection,
} from "@/chat/conversations/projection";
import type { ConversationTurnFailureReason } from "@/chat/conversations/history";
import { ConversationTurnLifecycleService } from "@/chat/conversations/turn-lifecycle";
import { closeDb, getConversationEventStore } from "@/chat/db";
import type { PiMessage } from "@/chat/pi/messages";

const CONVERSATION_ID = "local:web:rejected-turn-history";
const REMOVED_IMAGE = {
  type: "text",
  text: "[image removed: the model provider rejected a request that contained it]",
};

afterEach(closeDb);

function assistant(
  content: AssistantMessage["content"],
  stop: Pick<AssistantMessage, "stopReason" | "errorMessage">,
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-test",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    timestamp: Date.now(),
    ...stop,
  };
}

/** One Turn that views an image and then ends the way `failureReason` says. */
async function runImageTurn(
  turnId: string,
  imageData: string,
  failureReason?: ConversationTurnFailureReason,
): Promise<void> {
  const lifecycle = new ConversationTurnLifecycleService(
    getConversationEventStore(),
  );
  await lifecycle.start({
    conversationId: CONVERSATION_ID,
    createdAtMs: Date.now(),
    inputMessageIds: [`${turnId}-input`],
    surface: "api",
    turnId,
  });
  const { messages: history } = await openConversationProjection({
    conversationId: CONVERSATION_ID,
  });
  const callId = `${turnId}-call`;
  await commitMessages({
    conversationId: CONVERSATION_ID,
    messages: [
      ...history,
      {
        role: "user",
        content: [{ type: "text", text: `look at ${turnId}` }],
        timestamp: Date.now(),
      },
      assistant(
        [{ type: "toolCall", id: callId, name: "viewImage", arguments: {} }],
        { stopReason: "toolUse" },
      ),
      {
        role: "toolResult",
        toolCallId: callId,
        toolName: "viewImage",
        content: [
          { type: "text", text: "Viewed." },
          { type: "image", data: imageData, mimeType: "image/png" },
        ],
        isError: false,
        timestamp: Date.now(),
      },
      failureReason
        ? assistant([], {
            stopReason: "error",
            errorMessage: "400 provider rejected the request",
          })
        : assistant([{ type: "text", text: "Looks fine." }], {
            stopReason: "stop",
          }),
    ] as PiMessage[],
  });
  if (failureReason) {
    await lifecycle.fail({
      conversationId: CONVERSATION_ID,
      createdAtMs: Date.now(),
      failureCode: "model_execution_failed",
      failureReason,
      turnId,
    });
  } else {
    await lifecycle.complete({
      conversationId: CONVERSATION_ID,
      createdAtMs: Date.now(),
      outcome: "success",
      turnId,
    });
  }
}

function toolResultContent(messages: PiMessage[]): unknown[] {
  return messages
    .filter((message) => message.role === "toolResult")
    .map((message) => (message as { content: unknown }).content);
}

it("replays a Turn that the provider rejected as invalid without its images", async () => {
  await runImageTurn("turn-completed", "kept-image");
  await runImageTurn("turn-rate-limited", "retryable-image", "rate_limit");
  // The provider rejected this Turn's request, for example for an image over
  // its size limit (Sentry issue JUNIOR-WA).
  await runImageTurn("turn-rejected", "oversized-image", "invalid_request");

  const { messages: next } = await openConversationProjection({
    conversationId: CONVERSATION_ID,
  });

  expect(toolResultContent(next)).toEqual([
    [
      { type: "text", text: "Viewed." },
      { type: "image", data: "kept-image", mimeType: "image/png" },
    ],
    [
      { type: "text", text: "Viewed." },
      { type: "image", data: "retryable-image", mimeType: "image/png" },
    ],
    [{ type: "text", text: "Viewed." }, REMOVED_IMAGE],
  ]);
  // The next Turn commits on top of the replayed history.
  await expect(
    commitMessages({
      conversationId: CONVERSATION_ID,
      messages: [
        ...next,
        {
          role: "user",
          content: [{ type: "text", text: "try again" }],
          timestamp: Date.now(),
        } as PiMessage,
      ],
    }),
  ).resolves.toMatchObject({ messages: { length: next.length + 1 } });
  // The event log keeps the original tool result.
  const events = await getConversationEventStore().loadHistory(CONVERSATION_ID);
  expect(
    JSON.stringify(events.filter((event) => event.data.type === "tool_result")),
  ).toContain("oversized-image");
});
