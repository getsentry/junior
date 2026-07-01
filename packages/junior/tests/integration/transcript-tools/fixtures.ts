import {
  createLocalSource,
  createSlackSource,
} from "@sentry/junior-plugin-api";
import type { ConversationStore } from "@/chat/conversations/store";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import { createSqlStore } from "@/chat/conversations/sql/store";
import { persistThreadStateById } from "@/chat/runtime/thread-state";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import {
  coerceThreadConversationState,
  type ConversationCompaction,
  type ConversationMessage,
} from "@/chat/state/conversation";
import type { ToolRuntimeContext } from "@/chat/tools/types";
import {
  createLocalJuniorSqlFixture,
  type LocalJuniorSqlFixture,
} from "../../fixtures/sql";

export const TRANSCRIPT_UNAVAILABLE_ERROR =
  "Transcript was not found or is not available from the current context.";

const noopSandbox = {} as any;
const noopEgress = {
  async fetch() {
    return new Response("ok");
  },
};

/** Build a Slack runtime context for transcript integration tests. */
export function slackContext(
  overrides: { destinationChannelId?: string; sourceChannelId?: string } = {},
): Extract<ToolRuntimeContext, { source: { platform: "slack" } }> {
  const sourceChannelId = overrides.sourceChannelId ?? "GPRIVATE";
  const destinationChannelId =
    overrides.destinationChannelId ?? sourceChannelId;
  return {
    destination: {
      platform: "slack",
      teamId: "T123",
      channelId: destinationChannelId,
    },
    source: createSlackSource({
      teamId: "T123",
      channelId: sourceChannelId,
      messageTs: "1700000000.000001",
      threadTs: "1700000000.000001",
    }),
    egress: noopEgress,
    sandbox: noopSandbox,
  };
}

/** Build a local runtime context for transcript integration tests. */
export function localContext(
  conversationId = "local:test:current",
): Extract<ToolRuntimeContext, { source: { platform: "local" } }> {
  return {
    destination: {
      platform: "local",
      conversationId,
    },
    egress: noopEgress,
    source: createLocalSource(conversationId),
    sandbox: noopSandbox,
  };
}

/** Build a retained transcript message fixture. */
export function message(
  id: string,
  text: string,
  overrides: Partial<ConversationMessage> = {},
): ConversationMessage {
  return {
    id,
    role: "user",
    text,
    createdAtMs: Date.parse("2026-06-11T12:00:00.000Z"),
    meta: { slackTs: "1700000000.000001" },
    ...overrides,
  };
}

/** Build a retained transcript compaction fixture. */
export function compaction(
  id: string,
  summary: string,
  coveredMessageIds = ["covered-1", "covered-2"],
): ConversationCompaction {
  return {
    id,
    summary,
    coveredMessageIds,
    createdAtMs: Date.parse("2026-06-11T11:00:00.000Z"),
  };
}

function stateStats(
  messages: ConversationMessage[],
  compactions: ConversationCompaction[],
) {
  const compactedMessageCount = compactions.reduce(
    (total, entry) => total + entry.coveredMessageIds.length,
    0,
  );
  return {
    compactedMessageCount,
    totalMessageCount: messages.length + compactedMessageCount,
    updatedAtMs: Date.parse("2026-06-11T12:00:00.000Z"),
  };
}

/** Persist one Slack conversation metadata row and matching thread-state body. */
export async function recordSlackTranscript(args: {
  channelId: string;
  compactions?: ConversationCompaction[];
  conversationId: string;
  lastActivityAtMs?: number;
  messages: ConversationMessage[];
  store: ConversationStore;
  teamId?: string;
  title: string;
}) {
  const nowMs = args.lastActivityAtMs ?? Date.parse("2026-06-11T12:00:00.000Z");
  await args.store.recordExecution({
    conversationId: args.conversationId,
    destination: {
      platform: "slack",
      teamId: args.teamId ?? "T123",
      channelId: args.channelId,
    },
    source: "slack",
    title: args.title,
    channelName: args.channelId,
    createdAtMs: nowMs,
    lastActivityAtMs: nowMs,
    updatedAtMs: nowMs,
    execution: {
      status: "idle",
      updatedAtMs: nowMs,
    },
  });

  const state = coerceThreadConversationState({});
  state.messages = args.messages;
  state.compactions = args.compactions ?? [];
  state.stats = {
    ...state.stats,
    ...stateStats(state.messages, state.compactions),
  };
  await persistThreadStateById(args.conversationId, { conversation: state });
}

/** Persist one local conversation metadata row and matching thread-state body. */
export async function recordLocalTranscript(args: {
  compactions?: ConversationCompaction[];
  conversationId: string;
  messages: ConversationMessage[];
  store: ConversationStore;
  title: string;
}) {
  const nowMs = Date.parse("2026-06-11T12:00:00.000Z");
  await args.store.recordExecution({
    conversationId: args.conversationId,
    destination: {
      platform: "local",
      conversationId: args.conversationId,
    },
    source: "local",
    title: args.title,
    channelName: args.conversationId,
    createdAtMs: nowMs,
    lastActivityAtMs: nowMs,
    updatedAtMs: nowMs,
    execution: {
      status: "idle",
      updatedAtMs: nowMs,
    },
  });

  const state = coerceThreadConversationState({});
  state.messages = args.messages;
  state.compactions = args.compactions ?? [];
  state.stats = {
    ...state.stats,
    ...stateStats(state.messages, state.compactions),
  };
  await persistThreadStateById(args.conversationId, { conversation: state });
}

/** Create a migrated SQL conversation store fixture for transcript tests. */
export async function setupFixture() {
  const fixture = await createLocalJuniorSqlFixture();
  await migrateSchema(fixture.sql);
  return {
    fixture,
    store: createSqlStore(fixture.sql),
  };
}

/** Close the SQL fixture and reset the state adapter. */
export async function closeFixture(fixture: LocalJuniorSqlFixture) {
  await resetTranscriptTestState();
  await fixture.close();
}

/** Reset transcript state between integration cases. */
export async function resetTranscriptTestState() {
  await disconnectStateAdapter();
}

/** Execute a tool definition directly in transcript integration tests. */
export async function executeTool<TInput>(tool: any, input: TInput) {
  if (typeof tool?.execute !== "function") {
    throw new Error("tool execute function missing");
  }
  return await tool.execute(input, {} as any);
}

/** Parse the JSON content returned by transcript tools. */
export function parseContent(result: any) {
  return JSON.parse(result.content[0].text);
}
