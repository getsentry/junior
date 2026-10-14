/** Shared parent Conversation setup for agent invocation integration tests. */
import { createSlackSource } from "@sentry/junior-plugin-api";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import { createSqlStore } from "@/chat/conversations/sql/store";
import { getConversationEventStore } from "@/chat/db";
import { createConfiguredJuniorSqlFixture } from "./sql";
export const parentConversationId = "local:test:parent-agent";
export const destination = {
  conversationId: parentConversationId,
  platform: "local",
} as const;
export const invocationInput = {
  actor: { name: "parent-agent", platform: "system" } as const,
  destination,
  input: "Summarize the durable task.",
  parentConversationId,
  reasoningLevel: "medium" as const,
};
export const slackParentConversationId = "slack:C123:1712345.0001";
export const slackDestination = {
  platform: "slack",
  teamId: "T123",
  channelId: "C123",
} as const;
const slackSource = createSlackSource({
  channelId: "C123",
  teamId: "T123",
  threadTs: "1712345.0001",
  visibility: "public",
});
export const slackInvocationInput = {
  ...invocationInput,
  actor: {
    platform: "slack",
    teamId: "T123",
    userId: "U123",
  } as const,
  destination: slackDestination,
  parentConversationId: slackParentConversationId,
};

export async function prepareParentConversation() {
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

export async function prepareSlackParentConversation() {
  const fixture = createConfiguredJuniorSqlFixture();
  await migrateSchema(fixture.sql);
  const conversationStore = createSqlStore(fixture.sql);
  await conversationStore.recordActivity({
    conversationId: slackParentConversationId,
    destination: slackDestination,
    nowMs: 1_000,
    sessionSource: slackSource,
    source: "slack",
    visibility: "public",
  });
  return { conversationStore, fixture };
}

export async function loadTurnEvents(conversationId: string) {
  return (await getConversationEventStore().loadHistory(conversationId)).filter(
    (event) =>
      event.data.type === "turn_started" ||
      event.data.type === "turn_completed" ||
      event.data.type === "turn_failed",
  );
}

export async function loadSubagentEvents(conversationId: string) {
  return (await getConversationEventStore().loadHistory(conversationId))
    .map((event) => event.data)
    .filter(
      (data) =>
        data.type === "subagent_started" || data.type === "subagent_ended",
    );
}
