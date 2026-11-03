import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createAgentInvocationForMessage,
  getAgentInvocation,
  getAgentInvocationTurnId,
} from "@/chat/agent-invocations/store";
import {
  createAndEnqueueAgentInvocation,
  enqueueAgentInvocation,
} from "@/chat/agent-invocations/work";
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

      let followUpId = "";
      let unappendedId = "";
      for (let tries = 1; tries <= CONVERSATION_WORK_MAX_RETRIES; tries++) {
        // Injected fault: the worker of this try is killed mid-run.
        await killWorker(queue.takeMessageFor(childConversationId));
        if (tries === CONVERSATION_WORK_MAX_RETRIES) {
          // The parent gives the dying child more work. Stopped work drops
          // its mailbox, so this task never runs either.
          const { invocation } = await createAgentInvocationForMessage({
            actor: invocationInput.actor,
            childConversationId,
            destination: invocationInput.destination,
            idempotencyKey: "crash-follow-up",
            input: "Also check the retry path.",
            parentConversationId,
            parentToolCallId: "call-message",
          });
          await enqueueAgentInvocation(invocation, {
            conversationStore,
            queue,
            state,
          });
          followUpId = invocation.invocationId;
          // A task whose append has not run yet starts new work instead.
          const { invocation: unappended } =
            await createAgentInvocationForMessage({
              actor: invocationInput.actor,
              childConversationId,
              destination: invocationInput.destination,
              idempotencyKey: "crash-unappended",
              input: "Then check the docs.",
              parentConversationId,
              parentToolCallId: "call-message-2",
            });
          unappendedId = unappended.invocationId;
        }
        await runHeartbeatAfterLeasesExpire(queue);
      }

      const child = await getConversationWorkState({
        conversationId: childConversationId,
      });
      expect(child?.execution.pendingMessages).toEqual([
        expect.objectContaining({
          input: expect.objectContaining({
            metadata: expect.objectContaining({
              agentInvocationId: unappendedId,
            }),
          }),
        }),
      ]);
      await expect(getAgentInvocation(unappendedId)).resolves.toMatchObject({
        mailboxStatus: "appended",
        status: "pending",
      });
      for (const id of [invocationId, followUpId]) {
        await expect(getAgentInvocation(id)).resolves.toMatchObject({
          parentMailboxStatus: "appended",
          status: "failed",
        });
      }
      const parent = await getConversationWorkState({
        conversationId: parentConversationId,
      });
      const stopped = expect.stringMatching(
        /stopped because its worker failed repeatedly/,
      );
      expect(parent?.messages.map((message) => message.input.text)).toEqual([
        stopped,
        stopped,
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
