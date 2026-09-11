import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Message } from "@earendil-works/pi-ai";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import { createConversationWorkSlackHarness } from "../fixtures/conversation-work";
import { createModelStream } from "../fixtures/model-stream";
import { resetSlackApiMockState } from "../msw/handlers/slack-api";

const ACTOR = "U123";

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
    let firstTurnMessages: Message[] | undefined;
    let secondTurnMessages: Message[] | undefined;
    const q = await createConversationWorkSlackHarness({
      modelStream: createModelStream([
        {
          type: "text",
          text: "First reply.",
          onRequest: (context) => {
            firstTurnMessages = structuredClone(context.messages);
          },
        },
        {
          type: "text",
          text: "Second reply.",
          onRequest: (context) => {
            secondTurnMessages = structuredClone(context.messages);
          },
        },
      ]),
    });

    await q.mention(ACTOR, "first request");
    await q.drain();
    expect(q.replies()).toEqual(["First reply."]);
    expect(firstTurnMessages).toBeDefined();

    await q.mention(ACTOR, "second request");
    await q.drain();
    expect(q.replies()).toEqual(["First reply.", "Second reply."]);
    expect(secondTurnMessages).toBeDefined();

    expect(secondTurnMessages!.slice(0, firstTurnMessages!.length)).toEqual(
      firstTurnMessages,
    );
  });
});
