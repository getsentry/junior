import { afterEach, expect, it, vi } from "vitest";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import { clearSlackPendingReactions } from "@/chat/task-execution/slack-work";
import { getConversationWorkState } from "@/chat/task-execution/store";
import {
  CONVERSATION_ID,
  createConversationWorkSlackHarness,
  createSlackAdapterFixture,
} from "../../fixtures/conversation-work";
import { slackApiOutbox } from "../../fixtures/slack-api-outbox";

afterEach(async () => {
  vi.restoreAllMocks();
  await disconnectStateAdapter();
});

it("continues receipt cleanup after an adapter setup failure", async () => {
  const harness = await createConversationWorkSlackHarness();
  await harness.send();
  await harness.send({ ts: "1712345.0002", threadTs: "1712345.0001" });
  const work = await getConversationWorkState({
    conversationId: CONVERSATION_ID,
    state: harness.state,
  });
  expect(work?.execution.pendingMessages).toHaveLength(2);
  const getSlackAdapter = vi
    .fn(createSlackAdapterFixture)
    .mockImplementationOnce(() => {
      throw new Error("Slack adapter unavailable");
    });
  await clearSlackPendingReactions({
    getSlackAdapter,
    messages: work!.execution.pendingMessages,
    state: harness.state,
  });
  expect(slackApiOutbox.reactionRemovals().map((call) => call.params)).toEqual([
    expect.objectContaining({
      channel: "C123",
      timestamp: "1712345.0002",
      name: "eyes",
    }),
  ]);
});
