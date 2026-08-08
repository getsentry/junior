import { afterEach, describe, expect, it, vi } from "vitest";
import { createLocalSource, createSlackSource } from "@sentry/junior-plugin-api";
import {
  completeAgentInvocation,
  createAgentInvocation,
  getAgentInvocation,
  getAgentInvocationParentResultMessageId,
} from "@/chat/agent-invocations/store";
import { notifyParentOfAgentInvocationResult } from "@/chat/agent-invocations/parent-notification";
import { recoverPendingAgentInvocationParentNotifications } from "@/chat/agent-dispatch/heartbeat";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import { createSqlStore } from "@/chat/conversations/sql/store";
import { disconnectStateAdapter, getStateAdapter } from "@/chat/state/adapter";
import { getConversationWorkState } from "@/chat/task-execution/store";
import { createAgentInvocationResultInboundMessage } from "@/chat/task-execution/synthetic-inbound";
import { createConversationWorkQueueTestAdapter } from "../fixtures/conversation-work";
import { createConfiguredJuniorSqlFixture } from "../fixtures/sql";
import { createTestChatRuntime } from "../fixtures/chat-runtime";
import {
  createTestDestination,
  createTestMessage,
  createTestThread,
  TEST_SLACK_TEAM_ID,
} from "../fixtures/slack-harness";
import {
  deliverAssistantMessagesForTest,
  flattenAgentRunRequestForTest,
} from "../fixtures/agent-runner";
import { completedAgentRun } from "@/chat/runtime/agent-run-outcome";

const localParentConversationId = "local:test:parent-agent";
const localDestination = {
  conversationId: localParentConversationId,
  platform: "local",
} as const;

async function prepareLocalParent() {
  const fixture = createConfiguredJuniorSqlFixture();
  await migrateSchema(fixture.sql);
  const conversationStore = createSqlStore(fixture.sql);
  await conversationStore.recordActivity({
    conversationId: localParentConversationId,
    destination: localDestination,
    nowMs: 1_000,
    source: "local",
  });
  return { conversationStore, fixture };
}

describe("agent invocation parent delivery", () => {
  afterEach(async () => {
    await disconnectStateAdapter();
    vi.restoreAllMocks();
  });

  it("repairs pending parent notification delivery once", async () => {
    const { fixture } = await prepareLocalParent();
    const queue = createConversationWorkQueueTestAdapter();
    const state = getStateAdapter();
    await state.connect();
    try {
      const created = await createAgentInvocation(
        {
          actor: { name: "parent-agent", platform: "system" },
          destination: localDestination,
          destinationVisibility: "private",
          idempotencyKey: "parent-notify-repair-1",
          input: "Summarize the durable task.",
          parentConversationId: localParentConversationId,
          source: createLocalSource(localParentConversationId),
        },
        2_000,
      );
      await completeAgentInvocation({
        invocationId: created.invocationId,
        nowMs: 3_000,
        result: "Parent should see this.",
        status: "completed",
      });

      await recoverPendingAgentInvocationParentNotifications({
        conversationWorkQueue: queue,
        nowMs: 4_000,
      });
      await recoverPendingAgentInvocationParentNotifications({
        conversationWorkQueue: queue,
        nowMs: 5_000,
      });

      await expect(
        getAgentInvocation(created.invocationId),
      ).resolves.toMatchObject({
        parentNotificationStatus: "notified",
      });
      const parentWork = await getConversationWorkState({
        conversationId: localParentConversationId,
        state,
      });
      const resultId = getAgentInvocationParentResultMessageId(
        created.invocationId,
      );
      expect(
        parentWork?.messages.filter(
          (message) => message.inboundMessageId === resultId,
        ),
      ).toHaveLength(1);
      expect(
        queue
          .sentRecords()
          .filter(
            (record) => record.conversationId === localParentConversationId,
          ),
      ).toHaveLength(1);
    } finally {
      await fixture.close();
    }
  });

  it("marks permanent destination mismatches failed instead of retrying", async () => {
    const fixture = createConfiguredJuniorSqlFixture();
    await migrateSchema(fixture.sql);
    const conversationStore = createSqlStore(fixture.sql);
    const queue = createConversationWorkQueueTestAdapter();
    const parentConversationId = "slack:C0PARENT:1700003000.001";
    try {
      await conversationStore.recordActivity({
        conversationId: parentConversationId,
        destination: {
          channelId: "C0PARENT",
          platform: "slack",
          teamId: TEST_SLACK_TEAM_ID,
        },
        nowMs: 1_000,
        source: "slack",
      });
      const created = await createAgentInvocation(
        {
          actor: {
            platform: "slack",
            teamId: TEST_SLACK_TEAM_ID,
            userId: "U0PARENT",
          },
          destination: {
            channelId: "C0OTHER",
            platform: "slack",
            teamId: TEST_SLACK_TEAM_ID,
          },
          destinationVisibility: "private",
          idempotencyKey: "parent-notify-failed-1",
          input: "Deliver with a mismatched destination.",
          parentConversationId,
          source: createSlackSource({
            channelId: "C0PARENT",
            teamId: TEST_SLACK_TEAM_ID,
            threadTs: "1700003000.001",
            visibility: "private",
          }),
        },
        2_000,
      );
      const terminal = await completeAgentInvocation({
        invocationId: created.invocationId,
        nowMs: 3_000,
        result: "Should not land in the parent mailbox.",
        status: "completed",
      });

      await notifyParentOfAgentInvocationResult(terminal!, {
        queue,
        nowMs: 4_000,
      });
      await recoverPendingAgentInvocationParentNotifications({
        conversationWorkQueue: queue,
        nowMs: 5_000,
      });

      await expect(
        getAgentInvocation(created.invocationId),
      ).resolves.toMatchObject({
        parentNotificationStatus: "failed",
      });
      expect(queue.sentRecords()).toEqual([]);
    } finally {
      await fixture.close();
    }
  });

  it("runs parent-result turns with the invocation actor and credentials", async () => {
    const fixture = createConfiguredJuniorSqlFixture();
    await migrateSchema(fixture.sql);
    const conversationStore = createSqlStore(fixture.sql);
    const parentConversationId = "slack:C0PARENT:1700003000.001";
    const slackDestination = {
      channelId: "C0PARENT",
      platform: "slack" as const,
      teamId: TEST_SLACK_TEAM_ID,
    };
    const parentActor = {
      platform: "slack" as const,
      teamId: TEST_SLACK_TEAM_ID,
      userId: "U0PARENT",
      userName: "parent-user",
      fullName: "Parent User",
    };
    const replyContexts: unknown[] = [];
    try {
      await conversationStore.recordActivity({
        conversationId: parentConversationId,
        destination: slackDestination,
        nowMs: 1_000,
        source: "slack",
      });
      const created = await createAgentInvocation(
        {
          actor: parentActor,
          credentialContext: {
            actor: { type: "user", userId: "U0PARENT" },
          },
          destination: slackDestination,
          destinationVisibility: "private",
          idempotencyKey: "parent-authority-1",
          input: "Inspect the failing checks.",
          parentConversationId,
          source: createSlackSource({
            channelId: slackDestination.channelId,
            teamId: slackDestination.teamId,
            threadTs: "1700003000.001",
            visibility: "private",
          }),
        },
        2_000,
      );
      await completeAgentInvocation({
        invocationId: created.invocationId,
        nowMs: 3_000,
        result: "Checks are green now.",
        status: "completed",
      });
      const inbound = createAgentInvocationResultInboundMessage({
        createdAtMs: 3_000,
        destination: slackDestination,
        inboundMessageId: getAgentInvocationParentResultMessageId(
          created.invocationId,
        ),
        invocationId: created.invocationId,
        parentConversationId,
        receivedAtMs: 4_000,
        text: "[agent invocation result]\n\nResult:\nChecks are green now.",
      });
      const metadata = inbound.input.metadata as {
        message: { raw?: Record<string, unknown> };
      };

      const { slackRuntime } = createTestChatRuntime({
        services: {
          subscribedReplyPolicy: {
            completeObject: async () => {
              throw new Error(
                "agent invocation results bypass subscribed classifier",
              );
            },
          },
          replyExecutor: {
            agentRunner: {
              run: async (request) => {
                replyContexts.push(flattenAgentRunRequestForTest(request));
                const piMessages = await deliverAssistantMessagesForTest(
                  request,
                  [{ text: "I used the child result." }],
                );
                return completedAgentRun({
                  text: "I used the child result.",
                  piMessages,
                  diagnostics: {
                    assistantMessageCount: 1,
                    modelId: "test-model",
                    outcome: "success",
                    toolCalls: [],
                    toolErrorCount: 0,
                    toolResultCount: 0,
                    usedPrimaryText: true,
                  },
                });
              },
            },
          },
        },
      });

      const thread = createTestThread({ id: parentConversationId });
      const message = createTestMessage({
        id: inbound.inboundMessageId,
        text: inbound.input.text,
        isMention: false,
        threadId: thread.id,
        author: {
          userId: "UJRNAGENT",
          userName: "junior-agent",
          fullName: "Junior agent",
          isBot: true,
        },
        raw: metadata.message.raw,
      });

      await slackRuntime.handleSubscribedMessage(thread, message, {
        destination: createTestDestination(thread),
      });

      expect(replyContexts).toEqual([
        expect.objectContaining({
          conversationId: parentConversationId,
          actor: parentActor,
          credentialContext: {
            actor: { type: "user", userId: "U0PARENT" },
          },
        }),
      ]);
      expect(
        (replyContexts[0] as { policy?: { disabledFeatures?: unknown } })
          ?.policy?.disabledFeatures,
      ).toBeUndefined();
      expect(thread.posts).toHaveLength(1);
      expect(JSON.stringify(thread.posts[0])).toContain(
        "I used the child result.",
      );
    } finally {
      await fixture.close();
    }
  });
});
