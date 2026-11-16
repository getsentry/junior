import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as Sentry from "@/chat/sentry";
import { logException } from "@/chat/logging";
import { finalizeFailedTurnReplyWithEvent } from "@/chat/services/turn-failure-response";

describe("turn failure event ID", () => {
  const sentEventIds: string[] = [];
  let client: ReturnType<typeof Sentry.init>;

  beforeAll(() => {
    client = Sentry.init({
      dsn: "https://public@example.com/1",
      defaultIntegrations: false,
      transport: () => ({
        send: async (envelope) => {
          const eventId = envelope[0].event_id;
          if (typeof eventId === "string") {
            sentEventIds.push(eventId);
          }
          return { statusCode: 200 };
        },
        flush: async () => true,
      }),
    });
  });

  afterAll(async () => {
    await client?.close();
  });

  it("references the event that was sent when the agent already captured the error", async () => {
    // The agent run captures a thrown error, then returns it as the
    // reply's provider error. The failure reply captures it again.
    const error = new Error("Status code 500 is not ok");
    const agentEventId = logException(
      error,
      "assistant.reply.generation.failed",
    );

    const finalized = finalizeFailedTurnReplyWithEvent({
      reply: {
        text: "",
        diagnostics: {
          outcome: "provider_error",
          modelId: "test-model",
          assistantMessageCount: 0,
          toolCalls: [],
          toolResultCount: 0,
          toolErrorCount: 0,
          usedPrimaryText: false,
          errorMessage: error.message,
          providerError: error,
        },
      },
      logException,
    });
    await client?.flush();

    expect(finalized.eventId).toBe(agentEventId);
    expect(sentEventIds).toEqual([agentEventId]);
    expect(finalized.reply.text).toContain(`event_id=${agentEventId}`);
  });
});
