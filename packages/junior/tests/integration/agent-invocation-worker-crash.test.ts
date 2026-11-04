import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createAgentInvocationForMessage,
  getAgentInvocation,
  getAgentInvocationTurnId,
} from "@/chat/agent-invocations/store";
import {
  buildAgentInvocationInboundMessage,
  createAndEnqueueAgentInvocation,
  enqueueAgentInvocation,
} from "@/chat/agent-invocations/work";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import {
  appendAndEnqueueInboundMessage,
  CONVERSATION_WORK_MAX_RETRIES,
  getConversationWorkState,
  recordConversationRetry,
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
      const statuses: (string | undefined)[] = [];
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
          // Injected fault: the enqueue dies after its mailbox write, before
          // it marks the invocation appended. No harness fault stops it there.
          await appendAndEnqueueInboundMessage({
            conversationStore,
            message: buildAgentInvocationInboundMessage(invocation),
            queue,
            state,
          });
          followUpId = invocation.invocationId;
        }
        await runHeartbeatAfterLeasesExpire(queue);
        statuses.push((await getAgentInvocation(invocationId))?.status);
      }

      // Each try before the last leaves it running for the next try.
      expect(statuses).toEqual([
        ...Array(CONVERSATION_WORK_MAX_RETRIES - 1).fill("running"),
        "failed",
      ]);
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

  it("tells the parent when a child worker fails past its last retry", async () => {
    vi.useFakeTimers({
      now: 1_800_000_000_000,
      toFake: ["Date", "setInterval", "clearInterval"],
    });
    const { conversationStore, fixture } = await prepareParentConversation();
    const { killWorker, queue, state } = await createConversationWorkHarness(
      neverRunAgentRunner(),
    );
    try {
      const { childConversationId, invocationId } =
        await createAndEnqueueAgentInvocation(
          { ...invocationInput, idempotencyKey: "retry-1" },
          { conversationStore, queue, state },
        );
      // Injected fault: the worker is killed mid-run, so it keeps its lease.
      await killWorker(queue.takeMessageFor(childConversationId));
      // The parent gives the running child more work.
      const { invocation: followUp } = await createAgentInvocationForMessage({
        actor: invocationInput.actor,
        childConversationId,
        destination: invocationInput.destination,
        idempotencyKey: "retry-follow-up",
        input: "Also check the retry path.",
        parentConversationId,
        parentToolCallId: "call-message",
      });
      await enqueueAgentInvocation(followUp, {
        conversationStore,
        queue,
        state,
      });
      const leaseToken = (
        await getConversationWorkState({ conversationId: childConversationId })
      )?.execution.lease?.token;
      // Injected fault: an error escapes the agent invocation worker on each
      // try, so the worker records a retry until the work stops and drops its
      // mailbox. No harness fault throws past the agent invocation worker.
      let retry = "recorded";
      while (retry !== "stopped") {
        retry = await recordConversationRetry({
          conversationId: childConversationId,
          leaseToken: leaseToken!,
          state,
        });
      }
      await runHeartbeatAfterLeasesExpire(queue);

      for (const id of [invocationId, followUp.invocationId]) {
        await expect(getAgentInvocation(id)).resolves.toMatchObject({
          parentMailboxStatus: "appended",
          status: "failed",
        });
      }
      const parent = await getConversationWorkState({
        conversationId: parentConversationId,
      });
      expect(parent?.messages).toHaveLength(2);
    } finally {
      await fixture.close();
    }
  });
});
