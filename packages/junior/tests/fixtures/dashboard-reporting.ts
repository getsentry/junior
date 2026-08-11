import { eq } from "drizzle-orm";
import { createPostgresJuniorSqlExecutor } from "@/db/postgres";
import { juniorConversations } from "@/db/schema";
import { historyItemFromPiMessage } from "@/chat/pi/conversation-events";
import type { PiMessage } from "@/chat/pi/messages";
import { readConversationDetail } from "@/api/conversations/detail";
import { slackIdFromText } from "./slack/factories/ids";

/** Build a history replacement entry from a pi message. */
export function replacement(message: PiMessage) {
  return {
    item: historyItemFromPiMessage(message, { authority: "context" }),
  };
}

/** Record a root conversation for dashboard reporting tests. */
export async function recordRoot(
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

/** Append a representative visible history stream for reporting assertions. */
export async function appendVisibleHistory(
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

/** Create a child conversation under a recorded root for reporting tests. */
export async function createChild(args: {
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

/** Load conversation detail or fail the test setup. */
export async function requireDetail(conversationId: string) {
  const detail = await readConversationDetail(conversationId);
  if (!detail) throw new Error(`Missing detail for ${conversationId}`);
  return detail;
}

/** Create a deferred promise for lock-ordering tests. */
export function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Wait until another application is blocked on a lock for the given query. */
export async function waitUntilApplicationWaitsOnLock(
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
