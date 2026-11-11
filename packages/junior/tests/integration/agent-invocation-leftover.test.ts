import { afterEach, describe, expect, it } from "vitest";
import type { PiMessage } from "@/chat/pi/messages";
import {
  createAgentInvocation,
  createAgentInvocationForMessage,
} from "@/chat/agent-invocations/create";
import {
  getAgentInvocationResultMessageId,
  getAgentInvocationTurnId,
  getAgentReplyMessageId,
} from "@/chat/agent-invocations/ids";
import { enqueueAgentReplyToParent } from "@/chat/agent-invocations/result";
import {
  completeAgentInvocation,
  getActiveAgentInvocationForConversation,
  getAgentInvocation,
  markAgentInvocationPaused,
  markAgentInvocationRunning,
} from "@/chat/agent-invocations/store";
import { enqueueAgentInvocation } from "@/chat/agent-invocations/work";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import { getConversationWorkState } from "@/chat/task-execution/store";
import {
  getTurnRecord,
  upsertTurnRecord,
} from "@/chat/task-execution/turn-cursor";
import {
  destination,
  invocationInput,
  parentConversationId,
  prepareParentConversation,
} from "../fixtures/agent-invocations";
import { createConversationWorkHarness } from "../fixtures/conversation-work";

describe("agent invocation left over from earlier work", () => {
  afterEach(async () => {
    await disconnectStateAdapter();
  });

  // A child with an active invocation left over from earlier work gets new
  // mailbox input. Only the new invocation may be active when it runs.
  it.each([
    { state: "running" as const, replied: false },
    { state: "paused" as const, replied: false },
    // Its `reply` reached the parent before the newer work ended its Turn.
    { state: "running" as const, replied: true },
  ])(
    "ends a leftover $state child invocation (replied: $replied) before new mailbox input runs",
    async ({ state: orphanState, replied }) => {
      const { conversationStore, fixture } = await prepareParentConversation();
      const activeAtRun: unknown[] = [];
      // Integration tests do not run the agent. The runner reads the run and
      // stops it, so its work retries until the test finishes the invocation.
      const { process, queue, state } = await createConversationWorkHarness({
        run: async (run) => {
          activeAtRun.push(
            await getActiveAgentInvocationForConversation(run.conversationId),
          );
          throw new Error("stop after reading the run");
        },
      });
      const parentMailbox = async () =>
        (
          await getConversationWorkState({
            conversationId: parentConversationId,
            state,
          })
        )?.messages ?? [];
      try {
        const orphan = await createAgentInvocation({
          ...invocationInput,
          agentName: "researcher",
          idempotencyKey: "orphan-1",
          parentToolCallId: "call-spawn",
        });
        const { childConversationId } = orphan;
        await markAgentInvocationRunning(orphan.invocationId);
        if (orphanState === "paused") {
          await markAgentInvocationPaused(orphan.invocationId);
        }
        const orphanTurnId = getAgentInvocationTurnId(orphan.invocationId);
        const reply = { text: "Orphan found it", toolCallId: "call-reply" };
        if (replied) {
          await enqueueAgentReplyToParent({
            queue,
            reply,
            sender: orphan,
            state,
          });
        }
        await upsertTurnRecord({
          actor: invocationInput.actor,
          conversationId: childConversationId,
          piMessages: [
            {
              role: "user",
              content: [{ type: "text", text: invocationInput.input }],
            },
            ...(replied
              ? [
                  {
                    role: "assistant",
                    content: [
                      {
                        type: "toolCall",
                        id: reply.toolCallId,
                        name: "reply",
                        arguments: { text: reply.text },
                      },
                    ],
                  },
                  {
                    role: "toolResult",
                    toolCallId: reply.toolCallId,
                    toolName: "reply",
                    content: [{ type: "text", text: "Reply saved." }],
                    details: { text: reply.text },
                    isError: false,
                  },
                ]
              : []),
          ] as PiMessage[],
          sliceId: 1,
          source: { kind: "agent_invocation" },
          state: orphanState,
          surface: "internal",
          turnId: orphanTurnId,
          turnStartMessageIndex: 0,
          ...(orphanState === "paused"
            ? { resumeReason: "yield" as const }
            : undefined),
        });
        const { invocation: queued } = await createAgentInvocationForMessage({
          actor: invocationInput.actor,
          childConversationId,
          destination,
          idempotencyKey: "parent-turn:call-message",
          input: "Also check the retry path.",
          parentConversationId,
          parentToolCallId: "call-message",
        });
        await enqueueAgentInvocation(queued, {
          conversationStore,
          queue,
          state,
        });

        await expect(
          process(queue.takeMessageFor(childConversationId)),
        ).resolves.toMatchObject({ status: "failed" });

        expect(activeAtRun).toEqual([
          expect.objectContaining({
            invocationId: queued.invocationId,
            status: "running",
          }),
        ]);
        await expect(
          getTurnRecord(childConversationId, orphanTurnId),
        ).resolves.not.toMatchObject({ state: orphanState });
        // The newer work does not continue the earlier task, so the earlier
        // agent invocation sends its own result before the newer one ends.
        // One that already replied completes and sends nothing more.
        await expect(
          getAgentInvocation(orphan.invocationId),
        ).resolves.toMatchObject({
          parentMailboxStatus: "appended",
          status: replied ? "completed" : "failed",
        });
        const orphanResult = expect.objectContaining({
          inboundMessageId: replied
            ? getAgentReplyMessageId(orphan.invocationId, reply.toolCallId)
            : getAgentInvocationResultMessageId(orphan.invocationId),
          input: expect.objectContaining({
            text: expect.stringMatching(
              replied
                ? /^<agent-result [^>]*status="completed"[\s\S]*\nOrphan found it\n/
                : orphanState === "paused"
                  ? /^<agent-result [^>]*status="failed"[\s\S]*\nThis task was not resumed\. Newer work for this child agent started/
                  : /^<agent-result [^>]*status="failed"[\s\S]*\nAgent invocation lost its worker/,
            ),
          }),
        });
        await expect(parentMailbox()).resolves.toEqual([orphanResult]);

        await completeAgentInvocation({
          invocationId: queued.invocationId,
          result: "Retry path checked",
          status: "completed",
        });
        await expect(
          process(queue.takeMessageFor(childConversationId)),
        ).resolves.toMatchObject({ status: "completed" });

        // A completed agent invocation saved before `reply` existed has no
        // reply in the parent's mailbox, so it still sends its result text.
        await expect(parentMailbox()).resolves.toEqual([
          orphanResult,
          expect.objectContaining({
            inboundMessageId: getAgentInvocationResultMessageId(
              queued.invocationId,
            ),
            input: expect.objectContaining({
              text: expect.stringMatching(
                /^<agent-result [^>]*status="completed"[\s\S]*\nRetry path checked\n/,
              ),
            }),
          }),
        ]);
      } finally {
        await fixture.close();
      }
    },
  );
});
