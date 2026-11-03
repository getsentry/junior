import { afterEach, describe, expect, it, vi } from "vitest";
import { runHeartbeat } from "@/chat/agent-dispatch/heartbeat";
import {
  getAgentInvocation,
  getAgentInvocationTurnId,
  markAgentInvocationPaused,
  markAgentInvocationRunning,
} from "@/chat/agent-invocations/store";
import { createAndEnqueueAgentInvocation } from "@/chat/agent-invocations/work";
import type { PiMessage } from "@/chat/pi/messages";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import {
  CONVERSATION_WORK_LEASE_TTL_MS,
  CONVERSATION_WORK_MAX_RETRIES,
  getConversationWorkState,
  startConversationWork,
} from "@/chat/task-execution/store";
import {
  getTurnRecord,
  upsertTurnRecord,
} from "@/chat/task-execution/turn-cursor";
import {
  invocationInput,
  parentConversationId,
  prepareParentConversation,
} from "../fixtures/agent-invocations";
import { createConversationWorkQueueTestAdapter } from "../fixtures/conversation-work";

describe("agent invocation worker crash", () => {
  afterEach(async () => {
    await disconnectStateAdapter();
    vi.restoreAllMocks();
  });

  // A worker that is killed (function timeout, OOM, deploy) never runs its
  // own failure path. Only the heartbeat sees the expired lease. When every
  // try dies, the parent must still get a result for the child.
  it.each([{ state: "running" as const }, { state: "paused" as const }])(
    "tells the parent when every try of a $state child dies mid-run",
    async ({ state: turnState }) => {
      const clock = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
      const { conversationStore, fixture } = await prepareParentConversation();
      const queue = createConversationWorkQueueTestAdapter();
      try {
        const created = await createAndEnqueueAgentInvocation(
          { ...invocationInput, idempotencyKey: "crash-1" },
          { conversationStore, queue },
        );
        const { childConversationId, invocationId } = created;
        const turnId = getAgentInvocationTurnId(invocationId);
        // The first slice started, and maybe yielded, before the worker died.
        await markAgentInvocationRunning(invocationId);
        if (turnState === "paused") {
          await markAgentInvocationPaused(invocationId);
        }
        await upsertTurnRecord({
          actor: invocationInput.actor,
          conversationId: childConversationId,
          piMessages: [
            {
              role: "user",
              content: [{ type: "text", text: invocationInput.input }],
            },
          ] as PiMessage[],
          sliceId: 1,
          source: { kind: "agent_invocation" },
          state: turnState,
          surface: "internal",
          turnId,
          turnStartMessageIndex: 0,
          ...(turnState === "paused"
            ? { resumeReason: "yield" as const }
            : undefined),
        });

        // Fault: each try takes the lease, then the process dies.
        for (let tries = 0; tries < CONVERSATION_WORK_MAX_RETRIES; tries++) {
          await expect(
            startConversationWork({
              conversationId: childConversationId,
              nowMs: clock(),
            }),
          ).resolves.toMatchObject({ status: "acquired" });
          clock.mockReturnValue(clock() + CONVERSATION_WORK_LEASE_TTL_MS + 1);
          await runHeartbeat({ conversationWorkQueue: queue, nowMs: clock() });
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
          getTurnRecord(childConversationId, turnId),
        ).resolves.not.toMatchObject({ state: turnState });
      } finally {
        await fixture.close();
      }
    },
  );
});
