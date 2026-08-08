import { afterEach, describe, expect, it, vi } from "vitest";
import { createLocalSource, createSlackSource } from "@sentry/junior-plugin-api";
import {
  completeAgentInvocation,
  createAgentInvocation,
  getAgentInvocation,
  getAgentInvocationParentResultMessageId,
} from "@/chat/agent-invocations/store";
import {
  buildAgentInvocationParentResultInboundMessage,
  notifyParentOfAgentInvocationResult,
  PermanentAgentInvocationParentNotificationError,
} from "@/chat/agent-invocations/parent-notification";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import { createSqlStore } from "@/chat/conversations/sql/store";
import { disconnectStateAdapter, getStateAdapter } from "@/chat/state/adapter";
import { recoverPendingAgentInvocationParentNotifications } from "@/chat/agent-dispatch/heartbeat";
import { getConversationWorkState } from "@/chat/task-execution/store";
import { createConversationWorkQueueTestAdapter } from "../fixtures/conversation-work";
import { createConfiguredJuniorSqlFixture } from "../fixtures/sql";

const parentConversationId = "local:test:parent-agent";
const destination = {
  conversationId: parentConversationId,
  platform: "local",
} as const;
const invocationInput = {
  actor: { name: "parent-agent", platform: "system" } as const,
  destination,
  destinationVisibility: "private" as const,
  input: "Summarize the durable task.",
  parentConversationId,
  reasoningLevel: "medium" as const,
  source: createLocalSource(parentConversationId),
};

async function prepareParentConversation() {
  const fixture = createConfiguredJuniorSqlFixture();
  await migrateSchema(fixture.sql);
  const conversationStore = createSqlStore(fixture.sql);
  await conversationStore.recordActivity({
    conversationId: parentConversationId,
    destination,
    nowMs: 1_000,
    source: "local",
  });
  return { conversationStore, fixture };
}

describe("agent invocation parent notification", () => {
  afterEach(async () => {
    await disconnectStateAdapter();
    vi.restoreAllMocks();
  });

  it("repairs pending parent notification delivery once", async () => {
    const { fixture } = await prepareParentConversation();
    const queue = createConversationWorkQueueTestAdapter();
    const state = getStateAdapter();
    await state.connect();
    try {
      const created = await createAgentInvocation(
        {
          ...invocationInput,
          idempotencyKey: "parent-notify-repair-1",
        },
        2_000,
      );
      const terminal = await completeAgentInvocation({
        invocationId: created.invocationId,
        nowMs: 3_000,
        result: "Parent should see this.",
        status: "completed",
      });
      expect(terminal).toMatchObject({
        parentNotificationStatus: "pending",
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
        conversationId: parentConversationId,
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
          .filter((record) => record.conversationId === parentConversationId),
      ).toHaveLength(1);
      const parentResult = parentWork?.messages.find(
        (message) => message.inboundMessageId === resultId,
      );
      expect(parentResult?.input.metadata).toMatchObject({
        agentInvocationId: created.invocationId,
        kind: "agent_invocation_result",
      });
    } finally {
      await fixture.close();
    }
  });

  it("delivers parent results to agent-dispatch parents without parsing conversation id as slack", async () => {
    const fixture = createConfiguredJuniorSqlFixture();
    await migrateSchema(fixture.sql);
    const conversationStore = createSqlStore(fixture.sql);
    const queue = createConversationWorkQueueTestAdapter();
    const state = getStateAdapter();
    await state.connect();
    const dispatchParentId = "agent-dispatch:dispatch_parent_result_1";
    const slackDestination = {
      channelId: "C123",
      platform: "slack" as const,
      teamId: "T123",
    };
    try {
      await conversationStore.recordActivity({
        conversationId: dispatchParentId,
        destination: slackDestination,
        nowMs: 1_000,
        source: "plugin",
      });
      const created = await createAgentInvocation(
        {
          actor: { name: "dispatch-parent", platform: "system" },
          destination: slackDestination,
          destinationVisibility: "public",
          idempotencyKey: "dispatch-parent-1",
          input: "Inspect from a dispatch parent.",
          parentConversationId: dispatchParentId,
          source: createSlackSource({
            channelId: slackDestination.channelId,
            teamId: slackDestination.teamId,
            visibility: "public",
          }),
        },
        2_000,
      );
      const terminal = await completeAgentInvocation({
        invocationId: created.invocationId,
        nowMs: 3_000,
        result: "Dispatch parent should see this.",
        status: "completed",
      });
      expect(terminal).toMatchObject({
        parentConversationId: dispatchParentId,
        parentNotificationStatus: "pending",
      });

      await recoverPendingAgentInvocationParentNotifications({
        conversationWorkQueue: queue,
        nowMs: 4_000,
      });

      await expect(
        getAgentInvocation(created.invocationId),
      ).resolves.toMatchObject({
        parentNotificationStatus: "notified",
      });
      const parentWork = await getConversationWorkState({
        conversationId: dispatchParentId,
        state,
      });
      const resultId = getAgentInvocationParentResultMessageId(
        created.invocationId,
      );
      const parentResult = parentWork?.messages.find(
        (message) => message.inboundMessageId === resultId,
      );
      expect(parentResult).toMatchObject({
        conversationId: dispatchParentId,
        destination: slackDestination,
        source: "internal",
      });
      expect(parentResult?.input.metadata).toMatchObject({
        agentInvocationId: created.invocationId,
        kind: "agent_invocation_result",
        platform: "slack",
        route: "subscribed",
      });
      expect(
        (parentResult?.input.metadata as { message?: { raw?: unknown } })
          ?.message?.raw,
      ).toMatchObject({
        agent_invocation_id: created.invocationId,
        event_type: "agent_invocation_result",
      });
    } finally {
      await fixture.close();
    }
  });


  it("marks permanent parent notification failures without infinite retry", async () => {
    const fixture = createConfiguredJuniorSqlFixture();
    await migrateSchema(fixture.sql);
    const conversationStore = createSqlStore(fixture.sql);
    const queue = createConversationWorkQueueTestAdapter();
    const state = getStateAdapter();
    await state.connect();
    // Force a permanent builder mismatch: Slack destination channel differs
    // from the parent conversation id channel.
    const mismatchedSlackDestination = {
      channelId: "C999",
      platform: "slack" as const,
      teamId: "T999",
    };
    try {
      await conversationStore.recordActivity({
        conversationId: "slack:C123:111.222",
        destination: mismatchedSlackDestination,
        nowMs: 1_000,
        source: "slack",
      });
      const created = await createAgentInvocation(
        {
          actor: { name: "parent-agent", platform: "system" },
          destination: mismatchedSlackDestination,
          destinationVisibility: "public",
          idempotencyKey: "parent-notify-fail-1",
          input: "This delivery should fail permanently.",
          // Parent id claims a different Slack channel than destination.
          parentConversationId: "slack:C123:111.222",
          source: createSlackSource({
            channelId: "C123",
            teamId: "T999",
            visibility: "public",
          }),
        },
        2_000,
      );
      const terminal = await completeAgentInvocation({
        invocationId: created.invocationId,
        nowMs: 3_000,
        result: "unreachable parent result",
        status: "completed",
      });
      expect(terminal).toMatchObject({
        parentNotificationStatus: "pending",
        status: "completed",
      });

      expect(() =>
        buildAgentInvocationParentResultInboundMessage(terminal!, 4_000),
      ).toThrow(PermanentAgentInvocationParentNotificationError);

      await notifyParentOfAgentInvocationResult(terminal!, {
        conversationStore,
        nowMs: 4_000,
        queue,
        state,
      });
      await notifyParentOfAgentInvocationResult(
        (await getAgentInvocation(created.invocationId))!,
        {
          conversationStore,
          nowMs: 5_000,
          queue,
          state,
        },
      );

      await expect(getAgentInvocation(created.invocationId)).resolves.toMatchObject({
        parentNotificationStatus: "failed",
      });
      expect(queue.sentRecords()).toHaveLength(0);
      const parentWork = await getConversationWorkState({
        conversationId: "slack:C123:111.222",
        state,
      });
      expect(parentWork?.messages ?? []).toHaveLength(0);
    } finally {
      await fixture.close();
    }
  });

});
