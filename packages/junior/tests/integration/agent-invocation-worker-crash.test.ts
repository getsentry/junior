import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getAgentInvocation,
  getAgentInvocationTurnId,
} from "@/chat/agent-invocations/store";
import { createAndEnqueueAgentInvocation } from "@/chat/agent-invocations/work";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import {
  CONVERSATION_WORK_MAX_RETRIES,
  getConversationWorkState,
} from "@/chat/task-execution/store";
import { getTurnRecord } from "@/chat/task-execution/turn-cursor";
import { neverRunAgentRunner } from "../fixtures/agent-runner";
import {
  invocationInput,
  parentConversationId,
  prepareParentConversation,
} from "../fixtures/agent-invocations";
import {
  createConversationWorkHarness,
  runHeartbeatAfterLeasesExpire,
} from "../fixtures/conversation-work";

describe("agent invocation worker crash", () => {
  afterEach(async () => {
    vi.useRealTimers();
    await disconnectStateAdapter();
  });

  it("tells the parent when every try of a child worker is killed", async () => {
    vi.useFakeTimers({
      now: 1_800_000_000_000,
      toFake: ["Date", "setInterval", "clearInterval"],
    });
    const { conversationStore, fixture } = await prepareParentConversation();
    // Every try is killed before the agent can run.
    const { killWorker, queue, state } = await createConversationWorkHarness(
      neverRunAgentRunner(),
    );
    try {
      const created = await createAndEnqueueAgentInvocation(
        { ...invocationInput, idempotencyKey: "crash-1" },
        { conversationStore, queue, state },
      );
      const { childConversationId, invocationId } = created;

      for (let tries = 0; tries < CONVERSATION_WORK_MAX_RETRIES; tries++) {
        // Injected fault: the worker of this try is killed mid-run.
        await killWorker(queue.takeMessageFor(childConversationId));
        await runHeartbeatAfterLeasesExpire(queue);
      }

      await expect(
        getConversationWorkState({ conversationId: childConversationId }),
      ).resolves.toMatchObject({ execution: { status: "failed" } });
      await expect(getAgentInvocation(invocationId)).resolves.toMatchObject({
        parentMailboxStatus: "appended",
        status: "failed",
      });
      const parent = await getConversationWorkState({
        conversationId: parentConversationId,
      });
      expect(parent?.messages).toEqual([
        expect.objectContaining({
          input: expect.objectContaining({
            text: expect.stringMatching(
              /lost its worker|worker failed repeatedly/,
            ),
          }),
        }),
      ]);
      // Nothing may resume the dead Turn.
      await expect(
        getTurnRecord(
          childConversationId,
          getAgentInvocationTurnId(invocationId),
        ),
      ).resolves.not.toMatchObject({
        state: expect.stringMatching(/running|paused/),
      });
    } finally {
      await fixture.close();
    }
  });
});
