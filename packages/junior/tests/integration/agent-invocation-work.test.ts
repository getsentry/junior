import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createApp, defineJuniorPlugins } from "@/app";
import type { PiMessage } from "@/chat/pi/messages";
import {
  completeAgentInvocation,
  getActiveAgentInvocationForConversation,
  getAgentInvocation,
  getAgentInvocationMessageId,
  getAgentInvocationResultMessageId,
  getAgentInvocationTurnId,
} from "@/chat/agent-invocations/store";
import { withAgentInvocationResultActors } from "@/chat/agent-invocations/result";
import { EVENT_MESSAGE_AUTHOR, EVENT_SYSTEM_ACTOR } from "@/chat/events/actor";
import { getEventCatalog } from "@/chat/events/runtime-catalog";
import { runTimerWatchHeartbeat } from "@/chat/events/timers";
import { createEventTools } from "@/chat/tools/events";
import { createStopAgentTool } from "@/chat/tools/runtime/stop-agent";
import {
  CONVERSATION_WORK_MAX_RETRIES,
  getConversationWorkState,
} from "@/chat/task-execution/store";
import { createAndEnqueueAgentInvocation } from "@/chat/agent-invocations/work";
import { loadProjection } from "@/chat/conversations/projection";
import { getConversationEventStore } from "@/chat/db";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import { processConversationQueueMessage } from "@/chat/task-execution/vercel-callback";
import {
  getTurnRecord,
  upsertTurnRecord,
} from "@/chat/task-execution/turn-cursor";
import { createConversationWorkHarness } from "../fixtures/conversation-work";
import { context, execute } from "../fixtures/event-automations";
import {
  createModelAgentRunner,
  neverRunAgentRunner,
} from "../fixtures/agent-runner";
import { createModelStream } from "../fixtures/model-stream";
import {
  createEventSource,
  defineJuniorPlugin,
  definePluginTool,
  pluginToolOutputSchema,
} from "@sentry/junior-plugin-api";
import { getCurrentConversationPrivacy } from "@/chat/conversation-privacy";
import {
  destination,
  invocationInput,
  parentConversationId,
  slackDestination,
  slackInvocationInput,
  slackParentConversationId,
  prepareParentConversation,
  prepareSlackParentConversation,
  loadMessageEvents,
  loadTurnEvents,
  loadSubagentEvents,
} from "../fixtures/agent-invocations";

describe("agent invocation conversation work", () => {
  afterEach(async () => {
    await disconnectStateAdapter();
    vi.restoreAllMocks();
  });

  it("reads the parent Location and visibility without delivering child output", async () => {
    const { conversationStore, fixture } =
      await prepareSlackParentConversation();
    let observedVisibility: ReturnType<typeof getCurrentConversationPrivacy>;
    const agentRunner = createModelAgentRunner(
      createModelStream([
        {
          type: "text",
          text: "Durable child result",
          onRequest: () => {
            observedVisibility = getCurrentConversationPrivacy();
          },
        },
      ]),
    );
    const run = vi.spyOn(agentRunner, "run");
    const {
      queue,
      run: route,
      state,
    } = await createConversationWorkHarness(agentRunner);
    try {
      const created = await createAndEnqueueAgentInvocation(
        {
          ...slackInvocationInput,
          idempotencyKey: "execute-1",
        },
        {
          conversationStore,
          nowMs: 2_000,
          queue,
          state,
        },
      );
      const child = await conversationStore.get({
        conversationId: created.childConversationId,
      });
      expect(child).toMatchObject({
        parentConversationId: slackParentConversationId,
      });
      expect(child).not.toHaveProperty("destination");
      expect(child).not.toHaveProperty("location");
      expect(child).not.toHaveProperty("sessionSource");
      expect(child).not.toHaveProperty("visibility");
      const queueMessage = queue.takeMessage();

      await expect(
        processConversationQueueMessage(queueMessage, {
          conversationStore,
          queue,
          run: route,
          state,
        }),
      ).resolves.toMatchObject({ status: "completed" });
      await expect(
        processConversationQueueMessage(queueMessage, {
          conversationStore,
          queue,
          run: route,
          state,
        }),
      ).resolves.toMatchObject({ status: "no_work" });

      await expect(
        getAgentInvocation(created.invocationId),
      ).resolves.toMatchObject({
        mailboxStatus: "appended",
        parentMailboxStatus: "appended",
        result: "Durable child result",
        status: "completed",
        terminalAtMs: expect.any(Number),
      });
      // The parent gets one Event with the result, even after redelivery.
      const parentWork = await getConversationWorkState({
        conversationId: slackParentConversationId,
        state,
      });
      expect(parentWork?.messages).toEqual([
        expect.objectContaining({
          delivery: "defer",
          inboundMessageId: getAgentInvocationResultMessageId(
            created.invocationId,
          ),
          input: expect.objectContaining({
            metadata: {
              kind: "event",
              event: expect.objectContaining({
                eventType: "agent_invocation.completed",
                identifier: created.invocationId,
                namespace: "junior",
              }),
            },
            text: expect.stringMatching(
              /^\[agent result\][\s\S]*Durable child result/,
            ),
          }),
          source: "event",
        }),
      ]);
      expect(
        queue
          .sentRecords()
          .filter(
            (record) => record.conversationId === slackParentConversationId,
          ),
      ).toHaveLength(1);
      await expect(
        loadSubagentEvents(slackParentConversationId),
      ).resolves.toEqual([
        expect.objectContaining({
          type: "subagent_started",
          subagentInvocationId: created.invocationId,
          childConversationId: created.childConversationId,
        }),
        {
          type: "subagent_ended",
          subagentInvocationId: created.invocationId,
          outcome: "success",
        },
      ]);
      // The parent Turn uses the Actor that spawned the child, read from SQL.
      const resultMessage = parentWork!.messages[0]!;
      const resultEntry = {
        actor: EVENT_SYSTEM_ACTOR,
        author: EVENT_MESSAGE_AUTHOR,
        message: resultMessage,
        source: createEventSource({
          eventKey: created.invocationId,
          eventType: "agent_invocation.completed",
          identifier: created.invocationId,
          namespace: "junior",
        }),
      };
      await expect(
        withAgentInvocationResultActors({
          kind: "mailbox",
          batch: [resultEntry],
        }),
      ).resolves.toMatchObject({
        batch: [{ actor: slackInvocationInput.actor }],
      });
      await expect(
        withAgentInvocationResultActors({
          kind: "mailbox",
          batch: [
            {
              ...resultEntry,
              message: {
                ...resultMessage,
                conversationId: parentConversationId,
              },
            },
          ],
        }),
      ).rejects.toThrow("does not belong to");
      const completed = await getAgentInvocation(created.invocationId);
      await completeAgentInvocation({
        errorMessage: "late conflicting failure",
        invocationId: created.invocationId,
        nowMs: Date.now() + 1_000,
        status: "failed",
      });
      await expect(getAgentInvocation(created.invocationId)).resolves.toEqual(
        completed,
      );
      await expect(
        loadProjection({ conversationId: created.childConversationId }),
      ).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: "assistant",
            content: expect.arrayContaining([
              expect.objectContaining({
                type: "text",
                text: "Durable child result",
              }),
            ]),
          }),
        ]),
      );
      // A child has no Location, so the dashboard reads its input and result
      // from these message events.
      await expect(
        loadMessageEvents(created.childConversationId),
      ).resolves.toEqual([
        {
          type: "message",
          messageId: getAgentInvocationMessageId(created.invocationId),
          role: "user",
          text: slackInvocationInput.input,
          meta: { agentInvocationId: created.invocationId },
        },
        {
          type: "message",
          messageId: `agent-invocation:${created.invocationId}:reply`,
          role: "assistant",
          text: "Durable child result",
        },
      ]);
      await expect(
        loadTurnEvents(created.childConversationId),
      ).resolves.toEqual([
        expect.objectContaining({
          data: expect.objectContaining({
            inputMessageIds: [
              getAgentInvocationMessageId(created.invocationId),
            ],
            surface: "internal",
            turnId: getAgentInvocationTurnId(created.invocationId),
            type: "turn_started",
          }),
        }),
        expect.objectContaining({
          data: expect.objectContaining({
            outcome: "success",
            turnId: getAgentInvocationTurnId(created.invocationId),
            type: "turn_completed",
          }),
        }),
      ]);
      expect(run).toHaveBeenCalledOnce();
      expect(run.mock.calls[0]?.[0]).toMatchObject({
        conversationId: created.childConversationId,
        instruction: { text: slackInvocationInput.input },
        disabledFeatures: ["handoff", "interactive-auth", "subagents"],
        reasoning: "medium",
        actor: slackInvocationInput.actor,
        destination: slackDestination,
        location: {
          id: expect.any(String),
          provider: "slack",
          teamId: "T123",
          channelId: "C123",
          threadTs: "1712345.0001",
        },
        source: { kind: "agent_invocation" },
        surface: "internal",
        runId: created.invocationId,
      });
      expect(run.mock.calls[0]?.[0].delivery).toBeUndefined();
      expect(observedVisibility).toBe("public");
    } finally {
      await fixture.close();
    }
  });

  const blockedMissing = "Approval to open the PR. Ask the user.";
  it.each([
    {
      name: "failed",
      output: { type: "error" as const, errorMessage: "model unavailable" },
      invocation: { errorMessage: "model unavailable", status: "failed" },
      terminal: { failureCode: "model_execution_failed", type: "turn_failed" },
      subagentOutcome: "error",
    },
    {
      // A blocked report is a result, not a model failure.
      name: "blocked",
      output: {
        type: "toolCall" as const,
        name: "reportBlocked",
        arguments: { missing: blockedMissing },
      },
      invocation: { errorMessage: blockedMissing, status: "blocked" },
      terminal: { outcome: "blocked", type: "turn_completed" },
      subagentOutcome: "blocked",
    },
  ])(
    "finishes a $name child Turn after saving its result",
    async ({
      invocation: expectedInvocation,
      output,
      subagentOutcome,
      terminal,
    }) => {
      const { conversationStore, fixture } = await prepareParentConversation();
      const {
        queue,
        run: route,
        state,
      } = await createConversationWorkHarness(
        createModelAgentRunner(createModelStream([output])),
      );
      try {
        const created = await createAndEnqueueAgentInvocation(
          {
            ...invocationInput,
            idempotencyKey: "failed-result-1",
          },
          { conversationStore, queue, state },
        );

        await expect(
          processConversationQueueMessage(queue.takeMessage(), {
            conversationStore,
            queue,
            run: route,
            state,
          }),
        ).resolves.toMatchObject({ status: "completed" });

        await expect(
          getAgentInvocation(created.invocationId),
        ).resolves.toMatchObject(expectedInvocation);
        await expect(
          loadTurnEvents(created.childConversationId),
        ).resolves.toEqual([
          expect.objectContaining({
            data: expect.objectContaining({
              type: "turn_started",
              turnId: getAgentInvocationTurnId(created.invocationId),
            }),
          }),
          expect.objectContaining({
            data: expect.objectContaining({
              ...terminal,
              turnId: getAgentInvocationTurnId(created.invocationId),
            }),
          }),
        ]);
        await expect(loadSubagentEvents(parentConversationId)).resolves.toEqual(
          [
            expect.objectContaining({ type: "subagent_started" }),
            {
              type: "subagent_ended",
              subagentInvocationId: created.invocationId,
              outcome: subagentOutcome,
            },
          ],
        );
      } finally {
        await fixture.close();
      }
    },
  );

  // A child watch event runs with an event Source. When its Turn yields, the
  // next wake must still reach the agent invocation. Production once sent it
  // to the root Event Turn worker, which needs a Destination that a child
  // does not have. That also holds when the agent invocation ended or was
  // stopped while its Turn stayed paused. A resume wake has no messages, but
  // its last try is still final, so a resume that keeps failing tells the
  // parent.
  const resumed = { result: "Resumed child result", status: "completed" };
  it.each([
    {
      name: "a parent task",
      watchEvent: false,
      endBeforeWake: false,
      runs: 2,
      expected: resumed,
    },
    {
      name: "a watch event",
      watchEvent: true,
      endBeforeWake: false,
      runs: 3,
      expected: resumed,
    },
    {
      name: "an ended watch event",
      watchEvent: true,
      endBeforeWake: true,
      runs: 2,
      expected: { parentMailboxStatus: "appended", status: "failed" },
    },
    {
      name: "a stopped child",
      watchEvent: false,
      stopBeforeWake: true,
      runs: 1,
      expected: { parentMailboxStatus: "skipped", status: "stopped" },
    },
    {
      name: "a resume that keeps failing",
      watchEvent: false,
      // The last try is final, so it fails the invocation, not the work.
      failedResumes: CONVERSATION_WORK_MAX_RETRIES - 1,
      runs: CONVERSATION_WORK_MAX_RETRIES + 1,
      expected: {
        errorMessage: "resume unavailable",
        parentMailboxStatus: "appended",
        status: "failed",
      },
    },
  ])(
    "gives the wake after a yielded child invocation for $name to that invocation",
    async ({
      endBeforeWake,
      expected,
      failedResumes = 0,
      runs,
      stopBeforeWake = false,
      watchEvent,
    }) => {
      const clock = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
      const markDone = vi.fn((_input: { itemId: string }) => ({}));
      await createApp({
        plugins: defineJuniorPlugins([
          defineJuniorPlugin({
            manifest: {
              name: "upkeep",
              displayName: "Upkeep",
              description: "Upkeep test tools",
            },
            hooks: {
              tools: () => ({
                markDone: definePluginTool({
                  // The tool checks in code that its effect is safe, so action
                  // review does not run, also in a child agent.
                  approvalMode: "approve",
                  exposure: "direct",
                  annotations: {
                    destructiveHint: true,
                    idempotentHint: true,
                    openWorldHint: true,
                    readOnlyHint: false,
                  },
                  description: "Mark one item done.",
                  inputSchema: z.object({ itemId: z.string() }),
                  outputSchema: pluginToolOutputSchema,
                  execute: markDone,
                }),
              }),
            },
          }),
        ]),
      });
      const { conversationStore, fixture } = await prepareParentConversation();
      const agentRunner = createModelAgentRunner(
        createModelStream([
          ...(watchEvent ? [{ type: "text" as const, text: "Watching" }] : []),
          {
            type: "toolCall",
            name: "upkeep_markDone",
            arguments: { itemId: "item-7" },
          },
          { type: "text", text: "Resumed child result" },
        ]),
      );
      const run = vi.spyOn(agentRunner, "run");
      const {
        queue,
        run: route,
        state,
      } = await createConversationWorkHarness(agentRunner);
      try {
        const created = await createAndEnqueueAgentInvocation(
          {
            ...invocationInput,
            idempotencyKey: "resume-1",
          },
          { conversationStore, queue, state },
        );
        const { childConversationId } = created;
        // Child results also wake the parent. This test runs only the child.
        const processChild = async (softYieldAfterMs?: number) =>
          await processConversationQueueMessage(
            queue.takeMessageFor(childConversationId),
            {
              conversationStore,
              queue,
              run: route,
              state,
              ...(softYieldAfterMs === undefined
                ? undefined
                : { softYieldAfterMs }),
            },
          );
        if (watchEvent) {
          // Finish the parent task, then set a timer on the child. The timer
          // event waits for its burst window, then starts an agent invocation
          // with the event Source.
          await processChild();
          await execute(
            createEventTools(
              { ...context(), conversationId: childConversationId },
              getEventCatalog(),
            ).watchTimer!,
            { afterMs: 60_000, intent: "Check the PR checks." },
            "child-timer",
          );
          clock.mockReturnValue(clock() + 120_000);
          await runTimerWatchHeartbeat({ nowMs: clock(), queue });
          await processChild();
          clock.mockReturnValue(clock() + 120_000);
          await processChild(0);
        }

        await expect(processChild(0)).resolves.toMatchObject({
          status: "yielded",
        });
        const { invocationId } =
          (await getActiveAgentInvocationForConversation(childConversationId))!;
        await expect(
          getTurnRecord(
            childConversationId,
            getAgentInvocationTurnId(invocationId),
          ),
        ).resolves.toMatchObject({
          state: "paused",
          resumeReason: "yield",
          source: { kind: watchEvent ? "event" : "agent_invocation" },
          piMessages: expect.arrayContaining([
            expect.objectContaining({
              role: "toolResult",
              toolName: "upkeep_markDone",
            }),
          ]),
        });
        if (endBeforeWake) {
          await completeAgentInvocation({
            errorMessage: "Agent invocation ended",
            invocationId,
            status: "failed",
          });
        }
        if (stopBeforeWake) {
          // The stop request outlives the paused run. The stopped agent
          // invocation takes the resume wake and does not run again.
          await createStopAgentTool(parentConversationId).execute!(
            { conversation_id: childConversationId },
            {},
          );
        }
        if (failedResumes > 0) {
          run.mockRejectedValue(new Error("resume unavailable"));
        }
        for (let retry = 0; retry < failedResumes; retry++) {
          await expect(processChild()).resolves.toMatchObject({
            status: "failed",
          });
          // Each retry wake has a new idempotency key from the clock.
          clock.mockReturnValue(clock() + 1_000);
        }

        await expect(processChild()).resolves.toMatchObject({
          status: "completed",
        });
        expect(run).toHaveBeenCalledTimes(runs);
        await expect(getAgentInvocation(invocationId)).resolves.toMatchObject(
          expected,
        );
        // An ended child leaves no paused Turn that a later wake could resume.
        await expect(
          getTurnRecord(
            childConversationId,
            getAgentInvocationTurnId(invocationId),
          ),
        ).resolves.not.toMatchObject({ state: "paused" });
        const projection = await loadProjection({
          conversationId: childConversationId,
        });
        expect(
          projection.filter(
            (message) =>
              message.role === "toolResult" &&
              message.toolName === "upkeep_markDone",
          ),
        ).toHaveLength(1);
        // The approve tool skips action review, also in a child, and runs
        // once across the pause and the pick-up.
        expect(markDone).toHaveBeenCalledOnce();
        const events =
          await getConversationEventStore().loadHistory(childConversationId);
        expect(
          events.filter(
            (event) => event.data.type === "guardian_action_reviewed",
          ),
        ).toEqual([]);
      } finally {
        await fixture.close();
      }
    },
  );

  const missing = "Write access to getsentry/junior. Ask the user.";
  it.each([
    {
      name: "a reply",
      tail: [
        {
          role: "assistant",
          content: [{ type: "text", text: "Recovered visible result" }],
        },
      ],
      expected: { result: "Recovered visible result", status: "completed" },
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
      turnOutcome: "blocked",
    },
  ])(
    "recovers a completed child turn that ends with $name through production routing",
    async ({ expected, tail, turnOutcome }) => {
      const { conversationStore, fixture } = await prepareParentConversation();
      const {
        queue,
        run: route,
        state,
      } = await createConversationWorkHarness(neverRunAgentRunner());
      try {
        const created = await createAndEnqueueAgentInvocation(
          {
            ...invocationInput,
            idempotencyKey: "completed-recovery-1",
          },
          { conversationStore, queue, state },
        );
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
        });
        await expect(
          processConversationQueueMessage(queue.takeMessage(), {
            conversationStore,
            queue,
            run: route,
            state,
          }),
        ).resolves.toMatchObject({ status: "completed" });

        await expect(
          getAgentInvocation(created.invocationId),
        ).resolves.toMatchObject(expected);
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
