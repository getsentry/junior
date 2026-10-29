import { describe, expect, it } from "vitest";
import { readFailedCallRun } from "@junior-evals/fixture/results";

describe("failed call reporting", () => {
  it("keeps the original failure when its transcript cannot be read", async () => {
    const run = await readFailedCallRun({
      api: {
        request: async () => new Response("unavailable", { status: 500 }),
      },
      target: {
        conversationId: "failed-conversation",
        viewerEmail: "viewer@example.test",
        lastSeq: -1,
        started: true,
      },
      calls: [
        {
          conversationId: "earlier-conversation",
          events: [
            { type: "message", role: "user", content: "Earlier request" },
          ],
        },
      ],
      error: new Error("The agent was not idle within 60 seconds"),
      usage: { agentCostUsd: 0, gatewayRequests: {} },
      startedAtMs: Date.now(),
    });

    expect(run.errors).toMatchObject([
      { message: "The agent was not idle within 60 seconds" },
      { message: "Conversation detail returned 500: unavailable" },
    ]);
    expect(run.session?.events).toEqual([
      { type: "message", role: "user", content: "Earlier request" },
    ]);
  });
});
