import { afterEach, describe, expect, it, vi } from "vitest";
import { getNamedAgentConversationId } from "@/chat/agent-invocations/ids";
import { getConversationEventStore } from "@/chat/db";
import { createEventInboundMessage } from "@/chat/events/notification";
import { completedAgentRun } from "@/chat/runtime/agent-run-outcome";
import { createConversationTurnWorker } from "@/chat/task-execution/conversation-turn";
import { resolveMailboxTurnWork } from "@/chat/task-execution/mailbox-turn";
import { appendAndEnqueueInboundMessage } from "@/chat/task-execution/store";
import { consumeConversationQueueMessage } from "@/chat/task-execution/vercel-callback";
import {
  closeConversationFixture,
  createConversationFixture,
} from "../../fixtures/conversation";
import { deliverAssistantMessagesForTest } from "../../fixtures/agent-runner";

describe("Event Turn delivery to a Location", () => {
  afterEach(async () => {
    await closeConversationFixture();
    vi.restoreAllMocks();
  });

  it("saves a child's Event reply and posts nothing to its root's Location", async () => {
    const { conversationStore, queue, state } =
      await createConversationFixture();
    const rootConversationId = "slack:C123";
    const destination = {
      platform: "slack" as const,
      teamId: "T123",
      channelId: "C123",
    };
    await conversationStore.recordActivity({
      conversationId: rootConversationId,
      destination,
      nowMs: 1,
      source: "slack",
    });
    const conversationId = getNamedAgentConversationId(
      rootConversationId,
      "researcher",
    );
    await conversationStore.createChild({
      childConversationId: conversationId,
      kind: "task",
      nowMs: 1,
      parentConversationId: rootConversationId,
    });
    await expect(conversationStore.get({ conversationId })).resolves.toEqual(
      expect.objectContaining({
        location: expect.objectContaining({ channelId: "C123" }),
      }),
    );
    await appendAndEnqueueInboundMessage({
      conversationStore,
      // Production sends a child to its own worker before this one. Here the
      // Turn worker gets a child with a Destination, to check that it still
      // never posts.
      message: {
        ...createEventInboundMessage({
          event: {
            eventKey: "child-review-requested-1",
            eventType: "pull_request.review.requested",
            identifier: "getsentry/junior#1563",
            namespace: "github",
            occurredAtMs: 2,
            trustedSummary: "Code change review requested",
          },
          receivedAtMs: 2,
          subscription: { conversationId, id: "child-subscription-1" },
          text: "Code change review requested",
        }),
        destination,
      },
      queue,
      state,
    });
    const deliverMessage = vi.fn(async () => ({
      providerMessageId: "1712346.0002",
    }));
    const worker = createConversationTurnWorker(
      {
        run: async (run) => {
          await deliverAssistantMessagesForTest(run, [
            { text: "Child handled it." },
          ]);
          return completedAgentRun({
            text: "Child handled it.",
            diagnostics: {
              assistantMessageCount: 1,
              modelId: "fake-agent-model",
              outcome: "success",
              toolCalls: [],
              toolErrorCount: 0,
              toolResultCount: 0,
              usedPrimaryText: true,
            },
          });
        },
      },
      deliverMessage,
    );

    await consumeConversationQueueMessage(queue.takeMessage(), {
      messageId: "msg_child_event",
      queue,
      run: async (context) => {
        const resolved = await resolveMailboxTurnWork(context);
        if (!resolved) throw new Error("Expected Conversation mailbox work");
        return await worker(context, resolved);
      },
      state,
    });

    expect(deliverMessage).not.toHaveBeenCalled();
    const replies = (
      await getConversationEventStore().loadHistory(conversationId)
    ).flatMap((event) =>
      event.data.type === "message" && event.data.role === "assistant"
        ? [event.data.text]
        : [],
    );
    expect(replies).toEqual(["Child handled it."]);
  });
});
