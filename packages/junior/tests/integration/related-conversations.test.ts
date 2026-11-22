import { afterEach, describe, expect, it } from "vitest";
import { getConversationStore, getDb } from "@/chat/db";
import { createAgent } from "../fixtures/agent";
import { closeConversationFixture } from "../fixtures/conversation";
import { storeConversationMetadataFixture } from "../fixtures/conversation-metadata";
import { mockRetrievalModels } from "../fixtures/retrieval-models";

const KAFKA_CONVERSATION_ID = "slack:CKAFKA:1700000000.100000";
const LUNCH_CONVERSATION_ID = "slack:CLUNCH:1700000000.200000";

// Public Conversations that another person started, with a completed Turn.
async function recordOpenConversation(input: {
  channelId: string;
  conversationId: string;
  summary: string;
  title: string;
}): Promise<void> {
  await getConversationStore().recordActivity({
    conversationId: input.conversationId,
    channelName: input.channelId.toLowerCase(),
    destination: {
      platform: "slack",
      teamId: "T123",
      channelId: input.channelId,
    },
    nowMs: Date.now(),
    source: "slack",
    title: input.title,
    visibility: "public",
  });
  await storeConversationMetadataFixture(getDb(), {
    conversationId: input.conversationId,
    summary: input.summary,
    throughSeq: 1,
  });
}

const RELATED_CONTEXT = "These open conversations may be about the same work";

function modelInputText(agent: { snapshot(): { messages: unknown[] } }) {
  return JSON.stringify(agent.snapshot().messages);
}

describe("related conversations", () => {
  afterEach(async () => {
    await closeConversationFixture();
  });

  it("shows open work on the same topic on a person's first Turn only", async () => {
    await recordOpenConversation({
      channelId: "CKAFKA",
      conversationId: KAFKA_CONVERSATION_ID,
      summary: "Someone is fixing the Kafka consumer lag in the ingest worker.",
      title: "Kafka consumer lag",
    });
    await recordOpenConversation({
      channelId: "CLUNCH",
      conversationId: LUNCH_CONVERSATION_ID,
      summary: "The team lunch moved to Friday.",
      title: "Kafka lunch and learn",
    });
    // The reranker keeps only the Conversation about the same work.
    const rerankRequests = mockRetrievalModels({
      rerank: (_query, document) =>
        /consumer lag/i.test(document) ? 0.9 : 0.1,
    });
    const agent = await createAgent();

    await agent.run("Can you fix the Kafka consumer lag?");

    const first = modelInputText(agent);
    expect(first).toContain(RELATED_CONTEXT);
    expect(first).toContain(`- conversation_id: ${KAFKA_CONVERSATION_ID}`);
    expect(first).toContain("title: Kafka consumer lag");
    expect(first).not.toContain(LUNCH_CONVERSATION_ID);
    expect(rerankRequests).toHaveLength(1);

    await agent.run("Also check the retry settings for Kafka.");

    // The second Turn does not search again. Only the first Turn's context
    // in history has the block.
    expect(rerankRequests).toHaveLength(1);
    expect(modelInputText(agent).split(RELATED_CONTEXT)).toHaveLength(2);
  });

  it("runs the Turn without related conversations when reranking fails", async () => {
    await recordOpenConversation({
      channelId: "CKAFKA",
      conversationId: KAFKA_CONVERSATION_ID,
      summary: "Someone is fixing the Kafka consumer lag in the ingest worker.",
      title: "Kafka consumer lag",
    });
    const rerankRequests = mockRetrievalModels({ rerank: () => undefined });
    const agent = await createAgent();

    await agent.run("Can you fix the Kafka consumer lag?");

    expect(rerankRequests.length).toBeGreaterThan(0);
    expect(modelInputText(agent)).not.toContain(RELATED_CONTEXT);
  });
});
