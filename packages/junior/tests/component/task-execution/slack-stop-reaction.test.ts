import { afterEach, expect, it, vi } from "vitest";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import { clearSlackPendingReactions } from "@/chat/task-execution/slack-work";
import { getConversationWorkState } from "@/chat/task-execution/store";
import { neverRunAgentRunner } from "../../fixtures/agent-runner";
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

it("clears a receipt when a worker discards input before stop requests work", async () => {
  const harness = await createConversationWorkSlackHarness({
    agentRunner: neverRunAgentRunner(),
  });
  await harness.send();
  expect(slackApiOutbox.reactionAdds()).toHaveLength(1);
  // Only this component test controls the state boundary. The real worker
  // discards the mention after the watermark but before stop requests work.
  const releaseLock = harness.state.releaseLock.bind(harness.state);
  let drained = false;
  let idleBeforeStop = false;
  vi.spyOn(harness.state, "releaseLock").mockImplementation(async (lock) => {
    await releaseLock(lock);
    if (
      !drained &&
      lock.threadId === `slack:thread-stop-lock:${CONVERSATION_ID}`
    ) {
      drained = true;
      await harness.next();
      const work = await getConversationWorkState({
        conversationId: CONVERSATION_ID,
        state: harness.state,
      });
      idleBeforeStop =
        work?.execution.pendingMessages.length === 0 &&
        work.execution.runId === undefined;
    }
  });
  const response = await harness.send({
    text: "<@U0BOT> stop",
    ts: "1712345.0002",
    threadTs: "1712345.0001",
  });
  expect(response.status).toBe(200);
  expect(idleBeforeStop).toBe(true);
  expect(slackApiOutbox.reactionRemovals()[0]?.params).toMatchObject({
    channel: "C123",
    timestamp: "1712345.0001",
    name: "eyes",
  });
  expect(await harness.state.isSubscribed(CONVERSATION_ID)).toBe(false);
  expect(harness.replies()).toHaveLength(1);
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
