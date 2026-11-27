import { eq } from "drizzle-orm";
import { expectSqlBudget } from "../../../fixtures/sql-budget";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createJuniorApi } from "@/api";
import {
  CONVERSATION_DETAIL_VERSION_HEADER,
  conversationChildAgentsReportSchema,
  conversationDetailReportSchema,
} from "@/api/schema";
import { setConversationTitle } from "@/chat/conversations/sql/title";
import {
  closeDb,
  getConversationEventStore,
  getDb,
  getSqlExecutor,
} from "@/chat/db";
import { juniorConversations } from "@/db/schema";
import {
  spawnInput,
  parentConversationId,
  prepareParentConversation,
  prepareSlackParentConversation,
  slackSpawnInput,
  slackParentConversationId,
} from "../../../fixtures/child-agents";
import type { ConversationStore } from "@/chat/conversations/store";
import { startChildAgent } from "../../../fixtures/child-agent-start";
import { createConversationWorkQueueTestAdapter } from "../../../fixtures/conversation-work";

async function requestDetail(conversationId: string, etag?: string) {
  return await createJuniorApi().request(
    `http://localhost/api/conversations/${encodeURIComponent(conversationId)}`,
    { headers: etag ? { [CONVERSATION_DETAIL_VERSION_HEADER]: etag } : {} },
  );
}

async function requestChildAgents(conversationId: string) {
  return await createJuniorApi().request(
    `http://localhost/api/conversations/${encodeURIComponent(conversationId)}/agents`,
  );
}

describe("conversation child agents API", () => {
  afterEach(async () => {
    vi.useRealTimers();
    await closeDb();
  });

  // A child's update time is the time of its task in its mailbox.
  function spawn(
    conversationStore: ConversationStore,
    args: Omit<
      Parameters<typeof startChildAgent>[0],
      "actor" | "conversationStore" | "queue"
    >,
  ) {
    vi.useFakeTimers({ now: args.nowMs, toFake: ["Date"] });
    return startChildAgent({
      actor: slackSpawnInput.actor,
      conversationStore,
      queue: createConversationWorkQueueTestAdapter(),
      ...args,
    });
  }

  it("returns child agent state from each child's Conversation", async () => {
    const { conversationStore } = await prepareSlackParentConversation();
    const reviewer = await spawn(conversationStore, {
      agentName: "reviewer",
      idempotencyKey: "child-agents-reviewer",
      nowMs: 1_000,
      parentConversationId: slackParentConversationId,
      task: "Review the plan.",
      title: "Plan review",
    });
    const stopped = await spawn(conversationStore, {
      idempotencyKey: "child-agents-stopped",
      nowMs: 2_000,
      parentConversationId: slackParentConversationId,
      task: "Read the private repo.",
      title: "Private repo read",
    });

    // Archived Threads and Tasks stay in the report.
    const thread = await spawn(conversationStore, {
      idempotencyKey: "child-agents-thread",
      kind: "thread",
      nowMs: 500,
      parentConversationId: slackParentConversationId,
      task: "Pair on the rollout with the team.",
    });
    await getDb()
      .update(juniorConversations)
      .set({ archivedAt: new Date(4_000) })
      .where(eq(juniorConversations.conversationId, thread));
    await getDb()
      .update(juniorConversations)
      .set({
        archivedAt: new Date(3_500),
        executionUpdatedAt: new Date(3_000),
        stoppedAt: new Date(3_000),
      })
      .where(eq(juniorConversations.conversationId, stopped));

    await getDb()
      .update(juniorConversations)
      .set({
        durationMs: 42_000,
        usage: { cost: { total: 0.02 }, inputTokens: 900, outputTokens: 100 },
      })
      .where(eq(juniorConversations.conversationId, reviewer));
    // A nested child agent counts toward the reviewer, not only the root.
    const helper = await spawn(conversationStore, {
      idempotencyKey: "child-agents-reviewer-helper",
      nowMs: 1_500,
      parentConversationId: reviewer,
      task: "Check one claim.",
    });
    await getDb()
      .update(juniorConversations)
      .set({
        durationMs: 8_000,
        usage: { cost: { total: 0.01 }, inputTokens: 300, outputTokens: 50 },
      })
      .where(eq(juniorConversations.conversationId, helper));

    // A child row shows its newest message, like a feed row.
    await getConversationEventStore().append(reviewer, [
      {
        createdAtMs: 1_200,
        data: {
          messageId: "reviewer-reply",
          role: "assistant",
          text: "The plan holds.",
          type: "message",
        },
      },
    ]);

    const response = await expectSqlBudget(
      () => requestChildAgents(slackParentConversationId),
      // Each running child also checks, in one read, that its waiting task
      // comes from its parent and was sent after any stop. The tree states
      // of the children take one more read beside the metrics.
      { statements: 9, serialRounds: 5 },
    );
    const reviewerDetail = conversationDetailReportSchema.parse(
      await (await requestDetail(reviewer)).json(),
    );

    expect(response.status).toBe(200);
    // Each row is the child's Conversation feed row, with its agent facts.
    expect(
      conversationChildAgentsReportSchema.parse(await response.json()),
    ).toEqual({
      conversationId: slackParentConversationId,
      conversations: [
        expect.objectContaining({
          agentStatus: "stopped",
          archivedAt: new Date(3_500).toISOString(),
          conversationId: stopped,
          cumulativeDurationMs: 0,
          displayTitle: "Private repo read",
          kind: "task",
          parentConversationId: slackParentConversationId,
          // The test stops it without clearing its queued Turn.
          treeState: "working",
          watching: false,
        }),
        expect.objectContaining({
          activityPreview: {
            createdAt: new Date(1_200).toISOString(),
            role: "assistant",
            text: "The plan holds.",
          },
          agentStatus: "running",
          archivedAt: null,
          childAgentTotals: {
            count: 1,
            cumulativeDurationMs: 8_000,
            cumulativeUsage: {
              cost: { total: 0.01 },
              inputTokens: 300,
              outputTokens: 50,
            },
          },
          conversationId: reviewer,
          cumulativeDurationMs: 50_000,
          cumulativeUsage: {
            cost: { total: 0.03 },
            inputTokens: 1_200,
            outputTokens: 150,
          },
          displayTitle: "Plan review",
          kind: "task",
          name: "reviewer",
          // The reviewer's Turn is queued.
          treeState: "working",
        }),
        expect.objectContaining({
          agentStatus: "running",
          archivedAt: new Date(4_000).toISOString(),
          conversationId: thread,
          kind: "thread",
          treeState: "working",
        }),
      ],
    });
    expect(reviewerDetail).toMatchObject({
      childAgentTotals: { count: 1, cumulativeDurationMs: 8_000 },
      cumulativeDurationMs: 50_000,
      cumulativeUsage: {
        cost: { total: 0.03 },
        inputTokens: 1_200,
        outputTokens: 150,
      },
    });
  });

  it("returns the agent tree of a nested child Conversation", async () => {
    const { conversationStore } = await prepareSlackParentConversation();
    const reviewer = await spawn(conversationStore, {
      agentName: "reviewer",
      idempotencyKey: "agent-tree-reviewer",
      nowMs: 1_000,
      parentConversationId: slackParentConversationId,
      title: "Plan review",
    });
    const helper = await spawn(conversationStore, {
      agentConfig: { agentType: "explore", fork: true },
      idempotencyKey: "agent-tree-helper",
      nowMs: 2_000,
      parentConversationId: reviewer,
      task: "Check one claim.",
      title: "Claim check",
    });

    const root = conversationDetailReportSchema.parse(
      await (await requestDetail(slackParentConversationId)).json(),
    );
    const response = await requestDetail(helper);

    expect(root.agentTree).toBeUndefined();
    expect(response.status).toBe(200);
    expect(
      conversationDetailReportSchema.parse(await response.json()).agentTree,
    ).toEqual([
      {
        conversationId: slackParentConversationId,
        kind: "thread",
        label: root.displayTitle,
      },
      {
        conversationId: reviewer,
        kind: "task",
        label: "Plan review",
      },
      {
        agentType: "explore",
        conversationId: helper,
        fork: true,
        kind: "task",
        label: "Claim check",
      },
    ]);

    // An unchanged child answers 304. Renaming an ancestor changes the label
    // that the agent tree shows, so it changes the ETag.
    const etag = response.headers.get(CONVERSATION_DETAIL_VERSION_HEADER)!;
    expect((await requestDetail(helper, etag)).status).toBe(304);
    await setConversationTitle(
      getSqlExecutor(),
      slackParentConversationId,
      "Renamed plan",
    );
    const renamed = await requestDetail(helper, etag);
    expect(renamed.status).toBe(200);
    expect(
      conversationDetailReportSchema.parse(await renamed.json()).agentTree?.[0],
    ).toEqual({
      conversationId: slackParentConversationId,
      kind: "thread",
      label: "Renamed plan",
    });
  });

  it("redacts child agent content from viewers without private access", async () => {
    const { conversationStore } = await prepareParentConversation();
    vi.useFakeTimers({ now: 1_000, toFake: ["Date"] });
    const child = await startChildAgent({
      actor: spawnInput.actor,
      agentConfig: { agentType: "reviewer", fork: true },
      agentName: "private-reviewer",
      conversationStore,
      idempotencyKey: "child-agents-private",
      nowMs: 1_000,
      parentConversationId,
      queue: createConversationWorkQueueTestAdapter(),
      title: "Private plan review",
    });

    const response = await requestChildAgents(parentConversationId);
    const detail = await requestDetail(child);

    expect(
      conversationDetailReportSchema.parse(await detail.json()).agentTree?.[1],
    ).toEqual({
      conversationId: child,
      kind: "task",
      label: "Task",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      conversations: [
        {
          agentStatus: "running",
          archivedAt: null,
          conversationId: child,
          cumulativeDurationMs: 0,
          isParticipant: false,
          kind: "task",
          lastProgressAt: new Date(1_000).toISOString(),
          lastSeenAt: new Date(1_000).toISOString(),
          parentConversationId,
          redacted: true,
          startedAt: new Date(1_000).toISOString(),
          // State shows no content, so a redacted row keeps it.
          status: "working",
          surface: "internal",
          treeState: "working",
          turnActive: true,
          watching: false,
        },
      ],
      conversationId: parentConversationId,
    });
  });
});
