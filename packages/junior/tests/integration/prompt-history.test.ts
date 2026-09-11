import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Message } from "@earendil-works/pi-ai";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import { createConversationWorkSlackHarness } from "../fixtures/conversation-work";
import { createModelStream } from "../fixtures/model-stream";
import { resetSlackApiMockState } from "../msw/handlers/slack-api";

describe("prompt history", () => {
  beforeEach(async () => {
    resetSlackApiMockState();
    await disconnectStateAdapter();
  });

  afterEach(async () => {
    resetSlackApiMockState();
    await disconnectStateAdapter();
  });

  it("keeps the first Turn model messages as an exact prefix of the second Turn", async () => {
    const modelRequests: Message[][] = [];
    const agent = await createConversationWorkSlackHarness({
      modelStream: createModelStream([
        {
          type: "text",
          text: "First reply.",
          onRequest: (context) => {
            modelRequests.push(structuredClone(context.messages));
          },
        },
        {
          type: "text",
          text: "Second reply.",
          onRequest: (context) => {
            modelRequests.push(structuredClone(context.messages));
          },
        },
      ]),
    });

    await agent.run("first request");
    const firstTurnMessages = structuredClone(modelRequests.at(-1)!);

    await agent.run("second request");
    const secondTurnMessages = structuredClone(modelRequests.at(-1)!);

    expect(secondTurnMessages.slice(0, firstTurnMessages.length)).toEqual(
      firstTurnMessages,
    );
  });
});
