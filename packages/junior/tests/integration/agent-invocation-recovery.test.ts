import { afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { PiMessage } from "@/chat/pi/messages";
import { getSqlExecutor } from "@/chat/db";
import { juniorAgentInvocations } from "@/db/schema";
import {
  createAgentInvocation,
  createAgentInvocationForMessage,
} from "@/chat/agent-invocations/create";
import {
  getAgentInvocationResultMessageId,
  getAgentInvocationTurnId,
} from "@/chat/agent-invocations/ids";
import {
  appendAgentInvocationReport,
  getActiveAgentInvocationForConversation,
  getAgentInvocation,
  markAgentInvocationPaused,
  markAgentInvocationRunning,
  terminalAgentInvocation,
} from "@/chat/agent-invocations/store";
import { getConversationWorkState } from "@/chat/task-execution/store";
import {
  createAndEnqueueAgentInvocation,
  enqueueAgentInvocation,
} from "@/chat/agent-invocations/work";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import {
  getTurnRecord,
  upsertTurnRecord,
} from "@/chat/task-execution/turn-cursor";
import { createConversationWorkHarness } from "../fixtures/conversation-work";
import { neverRunAgentRunner } from "../fixtures/agent-runner";
import {
  destination,
  invocationInput,
  parentConversationId,
  prepareParentConversation,
  loadTurnEvents,
} from "../fixtures/agent-invocations";
import { finishAgentInvocation } from "@/chat/agent-invocations/finish";
import { enqueueAgentInvocationResult } from "@/chat/agent-invocations/result";

describe("agent invocation recovery", () => {
  afterEach(async () => {
    await disconnectStateAdapter();
    vi.restoreAllMocks();
  });

  // A child with an active invocation left over from earlier work gets new
  // mailbox input. Only the new invocation may be active when it runs.
  // Leftover own work, such as a Watch Event Run, fails too and names its
  // dropped input, so the parent knows that it never finished.
  it.each([
    { name: "running", state: "running" as const },
    { name: "paused", state: "paused" as const },
    { name: "paused own-work", ownWork: true, state: "paused" as const },
  ])(
    "ends a leftover $name child invocation before new mailbox input runs",
    async ({ ownWork = false, state: orphanState }) => {
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
          ...(ownWork
            ? { input: "<event>\nPR #12 was approved.\n</event>" }
            : { parentToolCallId: "call-spawn" }),
        });
        const { childConversationId } = orphan;
        if (ownWork) {
          // An Event batch saves its type and summary as the input label.
          await getSqlExecutor()
            .db()
            .update(juniorAgentInvocations)
            .set({ inputLabel: "pull_request.review.approved: PR #12" })
            .where(
              eq(juniorAgentInvocations.invocationId, orphan.invocationId),
            );
        }
        await markAgentInvocationRunning(orphan.invocationId);
        if (orphanState === "paused") {
          await markAgentInvocationPaused(orphan.invocationId);
        }
        const orphanTurnId = getAgentInvocationTurnId(orphan.invocationId);
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
        await expect(
          getAgentInvocation(orphan.invocationId),
        ).resolves.toMatchObject({
          status: "failed",
        });
        const orphanResult = expect.objectContaining({
          inboundMessageId: getAgentInvocationResultMessageId(
            orphan.invocationId,
          ),
          input: expect.objectContaining({
            text: expect.stringMatching(
              ownWork
                ? /^<agent-result [^>]*status="failed"[\s\S]*\nNewer work stopped this before it finished: pull_request\.review\.approved: PR #12\n/
                : orphanState === "paused"
                  ? /^<agent-result [^>]*status="failed"[\s\S]*\nThis task was not resumed\. Newer work for this child agent started/
                  : /^<agent-result [^>]*status="failed"[\s\S]*\nAgent invocation lost its worker/,
            ),
          }),
        });
        await expect(parentMailbox()).resolves.toEqual([orphanResult]);

        // The newer work finishes, as its worker would.
        await finishAgentInvocation({
          invocationId: queued.invocationId,
          closingReport: "Retry path checked",
          sendResult: async (terminal) =>
            await enqueueAgentInvocationResult(terminal, { queue, state }),
          status: "completed",
        });
        await expect(
          process(queue.takeMessageFor(childConversationId)),
        ).resolves.toMatchObject({ status: "completed" });

        await expect(parentMailbox()).resolves.toEqual([
          orphanResult,
          expect.objectContaining({
            inboundMessageId: getAgentInvocationResultMessageId(
              queued.invocationId,
            ),
            input: expect.objectContaining({
              text: expect.stringMatching(
                /status="completed">\n[\s\S]*\nRetry path checked\n<\/agent-result>$/,
              ),
            }),
          }),
        ]);
      } finally {
        await fixture.close();
      }
    },
  );

  const missing = "Write access to getsentry/junior. Ask the user.";
  it.each<{
    expected: Record<string, unknown>;
    name: string;
    ownWork?: boolean;
    parentInput: RegExp;
    savedReport?: string;
    sentBeforeCrash?: boolean;
    tail: unknown[];
    turnLimitWrappedUp?: boolean;
    turnOutcome: string;
  }>([
    {
      // `messageAgent` saved its report when it ran, before the crash.
      name: "a report",
      savedReport: "Recovered visible result",
      tail: [
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "tool-2",
              name: "messageAgent",
              arguments: { to: "parent", text: "Recovered visible result" },
            },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "tool-2",
          toolName: "messageAgent",
          content: [{ type: "text", text: "queued" }],
          isError: false,
        },
        { role: "assistant", content: [{ type: "text", text: "Sent." }] },
      ],
      expected: {
        reportLog: [
          expect.objectContaining({ text: "Recovered visible result" }),
        ],
        status: "completed",
      },
      parentInput: /\nRecovered visible result\n<\/agent-result>$/,
      turnOutcome: "success",
    },
    {
      // The finish sent the result, then the worker died before it saved
      // the end. Recovery sends it again, and the inbox keeps one copy.
      name: "a report sent before a crash",
      sentBeforeCrash: true,
      savedReport: "Recovered visible result",
      tail: [
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "tool-2",
              name: "messageAgent",
              arguments: { to: "parent", text: "Recovered visible result" },
            },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "tool-2",
          toolName: "messageAgent",
          content: [{ type: "text", text: "queued" }],
          isError: false,
        },
        { role: "assistant", content: [{ type: "text", text: "Sent." }] },
      ],
      expected: {
        reportLog: [
          expect.objectContaining({ text: "Recovered visible result" }),
        ],
        status: "completed",
      },
      parentInput: /\nRecovered visible result\n<\/agent-result>$/,
      turnOutcome: "success",
    },
    {
      name: "a blocked report",
      tail: [
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "tool-2",
              name: "reportBlocked",
              arguments: { missing },
            },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "tool-2",
          toolName: "reportBlocked",
          content: [{ type: "text", text: missing }],
          details: { missing },
          isError: false,
        },
      ],
      expected: { errorMessage: missing, status: "blocked" },
      parentInput: /^<agent-result [^>]*status="blocked">/,
      turnOutcome: "blocked",
    },
    ...[false, true].map((ownWork) => ({
      // After a turn-limit stop, the final response is sent as a report,
      // also when the worker died before it saved the result.
      name: `a turn-limit stop of ${ownWork ? "own work" : "a parent task"}`,
      ownWork,
      tail: [
        {
          role: "assistant",
          content: [{ type: "text", text: "Out of steps." }],
        },
      ],
      turnLimitWrappedUp: true,
      expected: {
        status: "completed",
      },
      parentInput: ownWork
        ? /^<agent-message [\s\S]*\nOut of steps\.\n<\/agent-message>$/
        : /status="completed">\n[\s\S]*\nOut of steps\.\n<\/agent-result>$/,
      turnOutcome: "success",
    })),
  ])(
    "recovers a completed child turn that ends with $name through production routing",
    async ({
      expected,
      ownWork,
      parentInput,
      savedReport,
      sentBeforeCrash = false,
      tail,
      turnLimitWrappedUp,
      turnOutcome,
    }) => {
      const { conversationStore, fixture } = await prepareParentConversation();
      const { process, queue, state } = await createConversationWorkHarness(
        neverRunAgentRunner(),
      );
      try {
        const created = await createAndEnqueueAgentInvocation(
          {
            ...invocationInput,
            idempotencyKey: "completed-recovery-1",
            ...(ownWork ? undefined : { parentToolCallId: "spawn-call" }),
          },
          { conversationStore, queue, state },
        );
        if (savedReport) {
          await appendAgentInvocationReport(created.invocationId, {
            kind: "report",
            text: savedReport,
            key: "tool-2",
          });
        }
        await upsertTurnRecord({
          actor: invocationInput.actor,
          conversationId: created.childConversationId,
          destination,
          piMessages: [
            {
              role: "user",
              content: [{ type: "text", text: invocationInput.input }],
            },
            {
              role: "assistant",
              content: [
                { type: "text", text: "Calling a tool" },
                {
                  type: "toolCall",
                  id: "tool-1",
                  name: "lookup",
                  arguments: {},
                },
              ],
            },
            {
              role: "toolResult",
              toolCallId: "tool-1",
              toolName: "lookup",
              content: [{ type: "text", text: "tool output" }],
              isError: false,
            },
            ...tail,
          ] as PiMessage[],
          turnId: getAgentInvocationTurnId(created.invocationId),
          turnStartMessageIndex: 0,
          sliceId: 1,
          source: { kind: "agent_invocation" },
          state: "completed",
          surface: "internal",
          ...(turnLimitWrappedUp ? { turnLimitWrappedUp } : undefined),
        });
        if (sentBeforeCrash) {
          await enqueueAgentInvocationResult(
            terminalAgentInvocation(
              (await getAgentInvocation(created.invocationId))!,
              { status: "completed" },
              Date.now(),
            ),
            { queue, state },
          );
        }
        await expect(
          process(queue.takeMessageFor(created.childConversationId)),
        ).resolves.toMatchObject({ status: "completed" });

        await expect(
          getAgentInvocation(created.invocationId),
        ).resolves.toMatchObject(expected);
        const parentWork = await getConversationWorkState({
          conversationId: parentConversationId,
          state,
        });
        expect(
          parentWork?.messages.map((message) => message.input.text),
        ).toEqual([expect.stringMatching(parentInput)]);
        await expect(
          loadTurnEvents(created.childConversationId),
        ).resolves.toEqual([
          expect.objectContaining({
            data: expect.objectContaining({
              outcome: turnOutcome,
              type: "turn_completed",
            }),
          }),
        ]);
      } finally {
        await fixture.close();
      }
    },
  );
});
