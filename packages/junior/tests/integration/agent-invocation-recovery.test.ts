import { afterEach, describe, expect, it } from "vitest";
import {
  createAgentInvocation,
  createAgentInvocationForMessage,
} from "@/chat/agent-invocations/create";
import { getAgentInvocationMessageId } from "@/chat/agent-invocations/ids";
import { recoverPendingAgentInvocationMailboxAppends } from "@/chat/agent-dispatch/heartbeat";
import { disconnectStateAdapter, getStateAdapter } from "@/chat/state/adapter";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";
import { getConversationWorkState } from "@/chat/task-execution/store";
import {
  createConversationWorkQueueTestAdapter,
  deferred,
} from "../fixtures/conversation-work";
import {
  invocationInput,
  parentConversationId,
  prepareParentConversation,
} from "../fixtures/agent-invocations";

describe("agent invocation mailbox recovery", () => {
  afterEach(async () => {
    await disconnectStateAdapter();
  });

  it("keeps the append order of one mailbox and does not wait on other mailboxes", async () => {
    const { fixture } = await prepareParentConversation();
    const state = getStateAdapter();
    await state.connect();
    try {
      const alpha = await createAgentInvocation(
        { ...invocationInput, agentName: "alpha", idempotencyKey: "alpha-1" },
        2_000,
      );
      const beta = await createAgentInvocation(
        { ...invocationInput, agentName: "beta", idempotencyKey: "beta-1" },
        2_100,
      );
      // A second message to alpha waits behind its first task.
      const { invocation: alphaMessage } =
        await createAgentInvocationForMessage(
          {
            actor: invocationInput.actor,
            childConversationId: alpha.childConversationId,
            destination: invocationInput.destination,
            idempotencyKey: "alpha-2",
            input: "Also check the follow-up.",
            parentConversationId,
            parentToolCallId: "call-alpha-2",
          },
          2_200,
        );

      // Hold alpha's first wake. Beta's append must not wait for it, and
      // alpha's second append must.
      const inner = createConversationWorkQueueTestAdapter();
      const releaseAlpha = deferred();
      const betaSent = deferred();
      const sent: string[] = [];
      let heldAlpha = false;
      const queue: ConversationWorkQueue = {
        async send(message, options) {
          sent.push(message.conversationId);
          if (message.conversationId === beta.childConversationId) {
            betaSent.resolve();
          }
          if (
            message.conversationId === alpha.childConversationId &&
            !heldAlpha
          ) {
            heldAlpha = true;
            await releaseAlpha.promise;
          }
          return await inner.send(message, options);
        },
      };

      const recovery = recoverPendingAgentInvocationMailboxAppends({
        conversationWorkQueue: queue,
        nowMs: 3_000,
      });
      await betaSent.promise;
      expect(sent).toEqual([
        alpha.childConversationId,
        beta.childConversationId,
      ]);
      releaseAlpha.resolve();
      await recovery;

      expect(sent).toEqual([
        alpha.childConversationId,
        beta.childConversationId,
        alpha.childConversationId,
      ]);
      const alphaWork = await getConversationWorkState({
        conversationId: alpha.childConversationId,
        state,
      });
      expect(
        alphaWork?.messages.map((message) => message.inboundMessageId),
      ).toEqual([
        getAgentInvocationMessageId(alpha.invocationId),
        getAgentInvocationMessageId(alphaMessage.invocationId),
      ]);
    } finally {
      await fixture.close();
    }
  });
});
