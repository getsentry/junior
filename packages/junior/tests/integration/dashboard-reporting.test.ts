import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readConversationDetail } from "@/api/conversations/detail";
import { readConversationFeedFromSql } from "@/api/conversations/list";
import { createSqlConversationEventStore } from "@/chat/conversations/sql/history";
import { purgeConversation } from "@/chat/conversations/retention";
import { historyItemFromPiMessage } from "@/chat/pi/conversation-events";
import type { PiMessage } from "@/chat/pi/messages";
import { createPostgresJuniorSqlExecutor } from "@/db/postgres";
import {
  juniorConversationEvents,
  juniorConversations,
  juniorDestinations,
  juniorIdentities,
} from "@/db/schema";
import { slackIdFromText } from "../fixtures/slack/factories/ids";

const ORIGINAL_ENV = { ...process.env };
const TEST_DATABASE_URL = ORIGINAL_ENV.DATABASE_URL;

function replacement(message: PiMessage) {
  return {
    item: historyItemFromPiMessage(message, { authority: "context" }),
  };
}

if (!TEST_DATABASE_URL) {
  throw new Error(
    "DATABASE_URL is required for dashboard reporting integration tests",
  );
}

async function recordRoot(
  conversationId: string,
  visibility: "private" | "public",
  actor?: {
    email: string;
    slackUserId: string;
    teamId: string;
  },
): Promise<void> {
  const { getConversationStore } = await import("@/chat/db");
  await getConversationStore().recordActivity({
    conversationId,
    destination: {
      platform: "slack",
      teamId: "TREPORTING",
      channelId: slackIdFromText("C", conversationId),
    },
    nowMs: 1,
    ...(actor ? { actor: { platform: "slack" as const, ...actor } } : {}),
    source: "slack",
    title: "Canonical event report",
    visibility,
  });
}

async function appendVisibleHistory(
  conversationId: string,
  text = "Visible answer",
): Promise<void> {
  const { getConversationEventStore } = await import("@/chat/db");
  const modelMessage = {
    role: "assistant",
    content: [{ type: "text", text: "private model-only duplicate" }],
    api: "responses",
    provider: "openai",
    model: "gpt-5",
    stopReason: "stop",
    timestamp: 11,
    usage: {
      input: 10,
      output: 2,
      cacheRead: 3,
      cacheWrite: 0,
      totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  } as PiMessage;
  await getConversationEventStore().append(conversationId, [
    {
      data: {
        type: "message",
        messageId: `${conversationId}:visible`,
        role: "assistant",
        text,
      },
      createdAtMs: 10,
    },
    {
      data: historyItemFromPiMessage(modelMessage, { authority: "context" }),
      createdAtMs: 11,
    },
    {
      data: {
        type: "tool_execution_started",
        toolCallId: `${conversationId}:tool-call`,
        toolName: "search",
      },
      createdAtMs: 12,
    },
    {
      data: historyItemFromPiMessage(
        {
          role: "assistant",
          api: "responses",
          provider: "openai",
          model: "gpt-5",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
          stopReason: "toolUse",
          content: [
            { type: "thinking", thinking: "Inspect the tool request." },
            {
              type: "toolCall",
              id: `${conversationId}:tool-call`,
              name: "search",
              arguments: { query: "visible tool query" },
            },
          ],
          timestamp: 12,
        } as PiMessage,
        { authority: "context" },
      ),
      createdAtMs: 12,
    },
    {
      data: historyItemFromPiMessage(
        {
          role: "toolResult",
          toolCallId: `${conversationId}:tool-call`,
          toolName: "search",
          content: [{ type: "text", text: "model-visible result" }],
          details: {
            matches: 2,
          },
          isError: false,
          timestamp: 13,
        } as PiMessage,
        { authority: "context" },
      ),
      createdAtMs: 13,
    },
    {
      data: {
        type: "turn_started",
        turnId: `${conversationId}:turn`,
        inputMessageIds: [`${conversationId}:visible`],
        surface: "internal",
      },
      createdAtMs: 13,
    },
    {
      data: {
        type: "turn_completed",
        turnId: `${conversationId}:turn`,
        outcome: "success",
      },
      createdAtMs: 14,
    },
    {
      data: {
        type: "subagent_started",
        subagentInvocationId: `${conversationId}:subagent-call`,
        subagentKind: "review",
        childConversationId: `${conversationId}:child`,
      },
      createdAtMs: 17,
    },
    {
      data: {
        type: "subagent_ended",
        subagentInvocationId: `${conversationId}:subagent-call`,
        outcome: "success",
      },
      createdAtMs: 18,
    },
  ]);
  await getConversationEventStore().replaceHistory(conversationId, {
    createdAtMs: 15,
    data: {
      type: "compaction",
      modelProfile: "standard",
      modelId: "private-model-id",
      summary: "Continue monitoring CI.",
      replacementHistory: [
        replacement(modelMessage),
        replacement({
          role: "user",
          content: "Private replacement context.",
          timestamp: 15,
        } as PiMessage),
      ],
    },
  });
  await getConversationEventStore().replaceHistory(conversationId, {
    createdAtMs: 16,
    data: {
      type: "handoff",
      modelProfile: "fast",
      modelId: "private-handoff-model-id",
      reasoningLevel: "high",
      triggeringToolCallId: `${conversationId}:handoff-tool-call`,
      summary: "Fix the remaining test.",
      replacementHistory: [
        replacement({
          role: "user",
          content: [
            {
              type: "text",
              text: "More private replacement context.",
            },
          ],
          timestamp: 16,
        } as PiMessage),
      ],
    },
  });
}

async function createChild(args: {
  childConversationId: string;
  parentConversationId: string;
}): Promise<void> {
  const { getConversationEventStore, getDb } = await import("@/chat/db");
  const at = new Date(3);
  const [parent] = await getDb()
    .select({ rootConversationId: juniorConversations.rootConversationId })
    .from(juniorConversations)
    .where(eq(juniorConversations.conversationId, args.parentConversationId));
  if (!parent?.rootConversationId) throw new Error("Missing conversation root");
  await getDb().insert(juniorConversations).values({
    conversationId: args.childConversationId,
    parentConversationId: args.parentConversationId,
    rootConversationId: parent.rootConversationId,
    createdAt: at,
    lastActivityAt: at,
    updatedAt: at,
    executionStatus: "idle",
  });
  await getConversationEventStore().append(args.parentConversationId, [
    {
      data: {
        type: "subagent_started",
        childConversationId: args.childConversationId,
        subagentInvocationId: `${args.childConversationId}:call`,
        subagentKind: "advisor",
      },
      createdAtMs: 2,
    },
    {
      data: {
        type: "subagent_ended",
        subagentInvocationId: `${args.childConversationId}:call`,
        outcome: "success",
      },
      createdAtMs: 3,
    },
  ]);
  await appendVisibleHistory(args.childConversationId, "Child answer");
}

async function requireDetail(conversationId: string) {
  const detail = await readConversationDetail(conversationId);
  if (!detail) throw new Error(`Missing detail for ${conversationId}`);
  return detail;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitUntilApplicationWaitsOnLock(
  observer: ReturnType<typeof createPostgresJuniorSqlExecutor>,
  applicationName: string,
  queryFragment: string,
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const [row] = await observer.query<{ count: number }>(
      `
        select count(*)::integer as count
        from pg_stat_activity
        where datname = current_database()
          and pid <> pg_backend_pid()
          and wait_event_type = 'Lock'
          and query ilike $1
      `,
      [`%${queryFragment}%`],
    );
    if ((row?.count ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`${applicationName} did not reach the expected lock wait`);
}

function reportingViewer(email: string) {
  return {
    email,
    id: `viewer:${email.trim().toLowerCase()}`,
    identities: [],
  };
}

describe("dashboard canonical event reporting", () => {
  beforeEach(async () => {
    process.env = {
      ...ORIGINAL_ENV,
      DATABASE_URL: TEST_DATABASE_URL,
      JUNIOR_STATE_ADAPTER: "memory",
    };
    vi.resetModules();
  });

  afterEach(async () => {
    const { disconnectStateAdapter } = await import("@/chat/state/adapter");
    const { closeDb } = await import("@/chat/db");
    await closeDb();
    await disconnectStateAdapter();
    vi.resetModules();
    process.env = { ...ORIGINAL_ENV };
  });

  it("returns one ordered safe event log without legacy detail projections", async () => {
    const conversationId = "slack:C-reporting:canonical-detail";
    await recordRoot(conversationId, "public");
    await appendVisibleHistory(conversationId);

    const detail = await requireDetail(conversationId);

    expect(detail.eventHistory).toEqual({ status: "available" });
    expect(detail.displayTitle).toBe("Canonical event report");
    expect(detail.modelUsage).toEqual([
      {
        modelId: "openai/gpt-5",
        usage: expect.objectContaining({
          inputTokens: 10,
          outputTokens: 2,
          cachedInputTokens: 3,
        }),
      },
    ]);
    expect(detail.events.map((event) => event.data)).toEqual([
      {
        type: "message",
        messageId: `${conversationId}:visible`,
        role: "assistant",
        text: "Visible answer",
      },
      {
        type: "tool_calls",
        calls: [
          {
            toolCallId: `${conversationId}:tool-call`,
            name: "search",
            status: "running",
            startedSeq: 2,
            startedAt: "1970-01-01T00:00:00.012Z",
          },
        ],
      },
      {
        type: "tool_calls",
        calls: [
          {
            toolCallId: `${conversationId}:tool-call`,
            name: "search",
            status: "running",
            startedSeq: 3,
            startedAt: "1970-01-01T00:00:00.012Z",
            input: { query: "visible tool query" },
          },
        ],
        assistant: {
          parts: [
            { type: "reasoning", text: "Inspect the tool request." },
            {
              type: "tool_call",
              toolCallId: `${conversationId}:tool-call`,
            },
          ],
        },
      },
      {
        type: "tool_calls",
        calls: [
          {
            toolCallId: `${conversationId}:tool-call`,
            name: "search",
            status: "completed",
            startedSeq: 2,
            startedAt: "1970-01-01T00:00:00.012Z",
            output: "model-visible result",
          },
        ],
      },
      {
        type: "turn_lifecycle",
        turnId: `${conversationId}:turn`,
        state: "started",
      },
      {
        type: "turn_lifecycle",
        turnId: `${conversationId}:turn`,
        state: "succeeded",
      },
      {
        type: "subagent",
        startedSeq: 7,
        startedAt: "1970-01-01T00:00:00.017Z",
        childConversationId: `${conversationId}:child`,
        subagentKind: "review",
        status: "running",
      },
      {
        type: "subagent",
        startedSeq: 7,
        startedAt: "1970-01-01T00:00:00.017Z",
        childConversationId: `${conversationId}:child`,
        subagentKind: "review",
        status: "completed",
      },
      {
        type: "compaction",
        modelProfile: "standard",
        modelId: "private-model-id",
        summary: "Continue monitoring CI.",
      },
      {
        type: "handoff",
        modelProfile: "fast",
        modelId: "private-handoff-model-id",
        reasoningLevel: "high",
        triggeringToolCallId: `${conversationId}:handoff-tool-call`,
        summary: "Fix the remaining test.",
      },
    ]);
    const eventSeqs = detail.events.map((event) => event.seq);
    expect(eventSeqs).toEqual(eventSeqs.slice().sort((a, b) => a - b));
    expect(JSON.stringify(detail)).not.toContain(
      "private model-only duplicate",
    );
    expect(JSON.stringify(detail)).not.toContain(
      "Private replacement context.",
    );
    expect(JSON.stringify(detail)).not.toContain(
      "More private replacement context.",
    );
    expect(JSON.stringify(detail)).toContain("private-model-id");
    expect(JSON.stringify(detail)).toContain("private-handoff-model-id");
    for (const removed of [
      "activity",
      "contextEvents",
      "modelId",
      "reasoningLevel",
      "transcript",
      "transcriptAvailable",
      "transcriptMetadata",
      "transcriptMessageCount",
    ]) {
      expect(detail).not.toHaveProperty(removed);
    }
  });

  it("aggregates per-model tokens and costs without counting replayed history", async () => {
    const conversationId = "slack:C-reporting:model-usage";
    await recordRoot(conversationId, "public");
    const componentUsageMessage = {
      role: "assistant",
      api: "responses",
      provider: "openai",
      model: "gpt-5",
      content: [],
      stopReason: "stop",
      timestamp: 10,
      usage: {
        input: 10,
        cost: {
          input: 0.01,
          output: 0.02,
          cacheRead: 0.003,
          cacheWrite: 0.004,
          total: 0.037,
        },
      },
    } as unknown as PiMessage;
    const totalOnlyUsageMessage = {
      role: "assistant",
      api: "responses",
      provider: "openai",
      model: "gpt-5",
      content: [],
      stopReason: "stop",
      timestamp: 11,
      usage: { totalTokens: 7, cost: { total: 0.005 } },
    } as unknown as PiMessage;
    const { getConversationEventStore } = await import("@/chat/db");
    await getConversationEventStore().append(conversationId, [
      {
        data: historyItemFromPiMessage(componentUsageMessage, {
          authority: "context",
        }),
        createdAtMs: 10,
      },
      {
        data: historyItemFromPiMessage(totalOnlyUsageMessage, {
          authority: "context",
        }),
        createdAtMs: 11,
      },
    ]);
    await getConversationEventStore().replaceHistory(conversationId, {
      createdAtMs: 1_000,
      data: {
        type: "compaction",
        modelProfile: "standard",
        modelId: "openai/gpt-5",
        replacementHistory: [
          replacement(componentUsageMessage),
          replacement(totalOnlyUsageMessage),
        ],
      },
    });

    expect((await requireDetail(conversationId)).modelUsage).toEqual([
      {
        modelId: "openai/gpt-5",
        usage: {
          inputTokens: 10,
          totalTokens: 17,
          cost: {
            input: 0.01,
            output: 0.02,
            cacheRead: 0.003,
            cacheWrite: 0.004,
            total: 0.042,
          },
        },
      },
    ]);
  });

  it("rolls unprojected child usage into a root conversation", async () => {
    const rootConversationId = "slack:C-reporting:tree-usage";
    const childConversationId = "child:reporting-unprojected-usage";
    await recordRoot(rootConversationId, "public");
    await appendVisibleHistory(rootConversationId);
    const { getDb } = await import("@/chat/db");
    const childAt = new Date(3);
    await getDb()
      .insert(juniorConversations)
      .values({
        conversationId: childConversationId,
        parentConversationId: rootConversationId,
        rootConversationId,
        createdAt: childAt,
        lastActivityAt: childAt,
        updatedAt: childAt,
        durationMs: 700,
        executionStatus: "idle",
        usage: { totalTokens: 7, cost: { total: 0.002 } },
      });
    await getDb()
      .update(juniorConversations)
      .set({
        durationMs: 300,
        usage: {
          inputTokens: 10,
          totalTokens: 999,
          cost: { total: 0.001 },
        },
      })
      .where(eq(juniorConversations.conversationId, rootConversationId));
    await appendVisibleHistory(childConversationId, "Unprojected child answer");

    const rootSummary = (
      await readConversationFeedFromSql()
    ).conversations.find(
      (conversation) => conversation.conversationId === rootConversationId,
    );
    expect(rootSummary?.cumulativeDurationMs).toBe(1_000);

    const rootDetail = await requireDetail(rootConversationId);
    expect(JSON.stringify(rootDetail.events)).not.toContain(
      childConversationId,
    );
    expect(rootDetail.cumulativeDurationMs).toBe(1_000);
    expect(rootDetail.cumulativeUsage).toEqual({
      totalTokens: 17,
      cost: { total: 0.003 },
    });
    expect(rootDetail.modelUsage).toEqual([
      {
        modelId: "openai/gpt-5",
        usage: expect.objectContaining({
          inputTokens: 20,
          outputTokens: 4,
          cachedInputTokens: 6,
          totalTokens: 30,
        }),
      },
    ]);

    const childDetail = await requireDetail(childConversationId);
    expect(childDetail.cumulativeDurationMs).toBe(700);
    expect(childDetail.cumulativeUsage).toEqual({
      totalTokens: 7,
      cost: { total: 0.002 },
    });
    expect(childDetail.modelUsage).toEqual([
      {
        modelId: "openai/gpt-5",
        usage: expect.objectContaining({ totalTokens: 15 }),
      },
    ]);
  });

  it("redacts visible content for a private root while retaining structure", async () => {
    const conversationId = "slack:C-reporting:private-detail";
    await recordRoot(conversationId, "private");
    await appendVisibleHistory(conversationId);

    const detail = await requireDetail(conversationId);

    expect(detail.eventHistory).toEqual({
      status: "redacted",
      reason: "non_public_conversation",
    });
    expect(detail.events[0]?.data).toEqual({
      type: "message",
      messageId: `${conversationId}:visible`,
      role: "assistant",
      redacted: true,
    });
    expect(detail.events[1]?.data).toEqual({
      type: "tool_calls",
      calls: [
        {
          toolCallId: `${conversationId}:tool-call`,
          name: "search",
          status: "running",
          startedSeq: 2,
          startedAt: "1970-01-01T00:00:00.012Z",
        },
      ],
    });
    const serialized = JSON.stringify(detail);
    expect(serialized).not.toContain("Visible answer");
    expect(serialized).not.toContain("visible tool query");
    expect(serialized).not.toContain("model-visible result");
    expect(serialized).not.toContain('"matches":2');
  });

  it("exposes a private root and child only to a verified participant", async () => {
    const rootConversationId = "slack:C-reporting:private-owner-root";
    const childConversationId = "child:reporting-private-owner";
    await recordRoot(rootConversationId, "private", {
      slackUserId: "U-owner",
      teamId: "TREPORTING",
      email: "Owner@Example.com",
    });
    const { getDb } = await import("@/chat/db");
    await appendVisibleHistory(rootConversationId, "Private owner answer");
    await createChild({
      childConversationId,
      parentConversationId: rootConversationId,
    });

    await expect(requireDetail(rootConversationId)).resolves.toMatchObject({
      eventHistory: { status: "redacted" },
      isParticipant: false,
    });
    expect(
      await readConversationDetail(rootConversationId, {
        viewer: reportingViewer("other@example.com"),
      }),
    ).toMatchObject({
      eventHistory: { status: "redacted" },
      isParticipant: false,
    });
    const rootParticipantDetail = await readConversationDetail(
      rootConversationId,
      { viewer: reportingViewer(" owner@example.COM ") },
    );
    expect(rootParticipantDetail).toMatchObject({
      displayTitle: "Canonical event report",
      isParticipant: true,
    });
    expect(rootParticipantDetail?.events[0]?.data).toMatchObject({
      text: "Private owner answer",
    });
    const rootParticipantSummary = (
      await readConversationFeedFromSql({
        viewer: reportingViewer("owner@example.com"),
      })
    ).conversations.find(
      (conversation) => conversation.conversationId === rootConversationId,
    );
    expect(rootParticipantSummary).toBeDefined();
    expect(rootParticipantDetail).toMatchObject(rootParticipantSummary ?? {});
    const childParticipantDetail = await readConversationDetail(
      childConversationId,
      { viewer: reportingViewer("owner@example.com") },
    );
    expect(childParticipantDetail).toMatchObject({ isParticipant: true });
    expect(childParticipantDetail?.events[0]?.data).toMatchObject({
      text: "Child answer",
    });

    await getDb()
      .update(juniorIdentities)
      .set({ emailVerified: false })
      .where(eq(juniorIdentities.providerSubjectId, "U-owner"));
    expect(
      await readConversationDetail(rootConversationId, {
        viewer: reportingViewer("owner@example.com"),
      }),
    ).toMatchObject({
      eventHistory: { status: "redacted" },
      isParticipant: false,
    });
  });

  it("authorizes children from their persisted root and rejects forged or malformed lineage", async () => {
    const publicRoot = "slack:C-reporting:public-root";
    const publicChild = "child:reporting-public";
    await recordRoot(publicRoot, "public");
    await createChild({
      childConversationId: publicChild,
      parentConversationId: publicRoot,
    });
    expect((await requireDetail(publicChild)).eventHistory).toEqual({
      status: "available",
    });
    const { getConversationStore, getDb } = await import("@/chat/db");
    const [rootRow] = await getDb()
      .select({ destinationId: juniorConversations.destinationId })
      .from(juniorConversations)
      .where(eq(juniorConversations.conversationId, publicRoot));
    if (!rootRow?.destinationId) throw new Error("Missing root destination");
    await getDb()
      .update(juniorDestinations)
      .set({ visibility: "private" })
      .where(eq(juniorDestinations.id, rootRow.destinationId));
    expect((await requireDetail(publicChild)).eventHistory.status).toBe(
      "redacted",
    );
    await getDb()
      .update(juniorDestinations)
      .set({ visibility: "public" })
      .where(eq(juniorDestinations.id, rootRow.destinationId));
    expect((await requireDetail(publicChild)).eventHistory.status).toBe(
      "available",
    );

    const privateRoot = "slack:C-reporting:private-root";
    const privateChild = "child:reporting-private";
    await recordRoot(privateRoot, "private");
    await createChild({
      childConversationId: privateChild,
      parentConversationId: privateRoot,
    });
    await getConversationStore().recordActivity({
      conversationId: privateChild,
      channelName: "forged-public-child-channel",
      destination: {
        platform: "slack",
        teamId: "TREPORTING",
        channelId: "CFORGEDCHILD",
      },
      title: "Forged public child title",
      visibility: "public",
    });
    const privateChildDetail = await requireDetail(privateChild);
    expect(privateChildDetail.eventHistory.status).toBe("redacted");
    expect(JSON.stringify(privateChildDetail)).not.toContain(
      "Forged public child title",
    );
    expect(JSON.stringify(privateChildDetail)).not.toContain(
      "forged-public-child-channel",
    );

    const cyclicRoot = "slack:C-reporting:cyclic-private-root";
    const cyclicChild = "child:reporting-cyclic-private";
    await recordRoot(cyclicRoot, "private", {
      slackUserId: "U-cyclic-owner",
      teamId: "TREPORTING",
      email: "cyclic-owner@example.com",
    });
    await appendVisibleHistory(cyclicRoot, "Cyclic private answer");
    await createChild({
      childConversationId: cyclicChild,
      parentConversationId: cyclicRoot,
    });
    await getDb()
      .update(juniorConversations)
      .set({ parentConversationId: cyclicChild })
      .where(eq(juniorConversations.conversationId, cyclicRoot));

    await expect(
      readConversationDetail(cyclicRoot, {
        viewer: reportingViewer("cyclic-owner@example.com"),
      }),
    ).resolves.toMatchObject({
      eventHistory: { status: "redacted" },
      isParticipant: false,
    });

    const destinationlessRoot = "slack:C-reporting:destinationless-root";
    await recordRoot(destinationlessRoot, "private", {
      slackUserId: "U-destinationless-owner",
      teamId: "TREPORTING",
      email: "destinationless-owner@example.com",
    });
    await appendVisibleHistory(
      destinationlessRoot,
      "Destinationless private answer",
    );
    await getDb()
      .update(juniorConversations)
      .set({ destinationId: null })
      .where(eq(juniorConversations.conversationId, destinationlessRoot));

    await expect(
      readConversationDetail(destinationlessRoot, {
        viewer: reportingViewer("destinationless-owner@example.com"),
      }),
    ).resolves.toMatchObject({
      eventHistory: { status: "available" },
      isParticipant: true,
    });
    const destinationlessSummary = (
      await readConversationFeedFromSql({
        viewer: reportingViewer("destinationless-owner@example.com"),
      })
    ).conversations.find(
      (conversation) => conversation.conversationId === destinationlessRoot,
    );
    expect(destinationlessSummary).toMatchObject({
      displayTitle: "Canonical event report",
      isParticipant: true,
    });

    const foreignRoot = "slack:C-reporting:foreign-private-root";
    const malformedTopLevel = "slack:C-reporting:malformed-top-level";
    await recordRoot(foreignRoot, "private", {
      slackUserId: "U-foreign-owner",
      teamId: "TREPORTING",
      email: "foreign-owner@example.com",
    });
    await recordRoot(malformedTopLevel, "private");
    await appendVisibleHistory(malformedTopLevel, "Malformed private answer");
    await getDb()
      .update(juniorConversations)
      .set({ rootConversationId: foreignRoot })
      .where(eq(juniorConversations.conversationId, malformedTopLevel));

    await expect(
      readConversationDetail(malformedTopLevel, {
        viewer: reportingViewer("foreign-owner@example.com"),
      }),
    ).resolves.toMatchObject({
      eventHistory: { status: "redacted" },
      isParticipant: false,
    });
    const malformedSummary = (
      await readConversationFeedFromSql({
        viewer: reportingViewer("foreign-owner@example.com"),
      })
    ).conversations.find(
      (conversation) => conversation.conversationId === malformedTopLevel,
    );
    expect(malformedSummary).toMatchObject({ isParticipant: false });
  });

  it("lets requested-row expiry win and stamps both root and child purges", async () => {
    const rootConversationId = "slack:C-reporting:purged-root";
    const childConversationId = "child:reporting-purged";
    await recordRoot(rootConversationId, "public");
    await createChild({
      childConversationId,
      parentConversationId: rootConversationId,
    });
    const { getSqlExecutor } = await import("@/chat/db");

    await purgeConversation(getSqlExecutor(), rootConversationId, {
      nowMs: 50,
    });

    for (const conversationId of [rootConversationId, childConversationId]) {
      const detail = await requireDetail(conversationId);
      expect(detail.eventHistory).toEqual({
        status: "expired",
        expiredAt: new Date(50).toISOString(),
      });
      expect(detail.events).toEqual([]);
      expect(detail.modelUsage).toBeUndefined();
    }
  });

  it("deletes child events when an append wins before tree purge", async () => {
    const rootConversationId = "slack:C-reporting:append-purge-root";
    const childConversationId = "child:reporting-append-purge";
    await recordRoot(rootConversationId, "public");
    await createChild({
      childConversationId,
      parentConversationId: rootConversationId,
    });

    const blocker = createPostgresJuniorSqlExecutor({
      applicationName: "junior-append-purge-table-blocker",
      connectionString: TEST_DATABASE_URL,
    });
    const observer = createPostgresJuniorSqlExecutor({
      applicationName: "junior-append-purge-observer",
      connectionString: TEST_DATABASE_URL,
    });
    const writer = createPostgresJuniorSqlExecutor({
      applicationName: "junior-append-purge-writer",
      connectionString: TEST_DATABASE_URL,
    });
    const purger = createPostgresJuniorSqlExecutor({
      applicationName: "junior-append-purge-purger",
      connectionString: TEST_DATABASE_URL,
    });
    const tablesLocked = deferred();
    const releaseTables = deferred();
    const blockerDone = blocker.transaction(async () => {
      await blocker.execute(
        "LOCK TABLE junior_conversation_events IN ACCESS EXCLUSIVE MODE",
      );
      tablesLocked.resolve();
      await releaseTables.promise;
    });

    try {
      await tablesLocked.promise;
      const completionOrder: string[] = [];
      const writerPromise = createSqlConversationEventStore(writer)
        .append(childConversationId, [
          {
            data: {
              type: "message",
              messageId: "concurrent-child-message",
              role: "assistant",
              text: "concurrent physical child payload",
            },
            createdAtMs: Date.now(),
          },
        ])
        .then(() => completionOrder.push("writer"));
      await waitUntilApplicationWaitsOnLock(
        observer,
        "junior-append-purge-writer",
        "junior_conversation_events",
      );

      const purgePromise = purgeConversation(purger, rootConversationId, {
        nowMs: Date.now(),
      }).then(() => completionOrder.push("purge"));
      await waitUntilApplicationWaitsOnLock(
        observer,
        "junior-append-purge-purger",
        "pg_advisory_xact_lock",
      );
      expect(completionOrder).toEqual([]);

      releaseTables.resolve();
      await blockerDone;
      await Promise.all([writerPromise, purgePromise]);
      expect(completionOrder).toEqual(["writer", "purge"]);

      for (const conversationId of [rootConversationId, childConversationId]) {
        const events = await observer
          .db()
          .select()
          .from(juniorConversationEvents)
          .where(eq(juniorConversationEvents.conversationId, conversationId));
        expect(events).toEqual([]);
      }
    } finally {
      releaseTables.resolve();
      await blockerDone.catch(() => undefined);
      await Promise.all([
        blocker.close(),
        observer.close(),
        writer.close(),
        purger.close(),
      ]);
    }
  }, 15_000);
});
