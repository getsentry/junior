import { describe, expect, it, vi } from "vitest";
import { createVercelConversationWorkQueue } from "@/chat/task-execution/vercel-queue";
import { CONVERSATION_ID } from "../fixtures/conversation-work";

/**
 * Contract test for the transport substituted by durable-queue integration tests.
 * Product code depends only on `send`; signing and provider option mapping belong
 * to the production Vercel implementation tested here.
 */
describe("conversation queue transport", () => {
  it("sends a signed wake with delay and idempotency", async () => {
    process.env.JUNIOR_SECRET = "conversation-work-secret";
    const send = vi.fn(async () => ({ messageId: "msg_123" }));
    const queue = createVercelConversationWorkQueue({
      topic: "junior_test_work",
      client: { send },
    });

    await expect(
      queue.send(
        { schemaVersion: 2, conversationId: CONVERSATION_ID },
        { delayMs: 15_001, idempotencyKey: "idem-1" },
      ),
    ).resolves.toEqual({ messageId: "msg_123" });
    expect(send).toHaveBeenCalledWith(
      "junior_test_work",
      expect.objectContaining({
        schemaVersion: 2,
        conversationId: CONVERSATION_ID,
        signature: expect.any(String),
        signatureVersion: "v2",
        signedAtMs: expect.any(Number),
      }),
      {
        delaySeconds: 16,
        idempotencyKey: "idem-1",
        retentionSeconds: 3_600,
      },
    );
  });
});
