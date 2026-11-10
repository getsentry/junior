import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "@/app";
import {
  getAgentInvocationMessageId,
  getAgentInvocationResultMessageId,
  getAgentInvocationTurnId,
} from "@/chat/agent-invocations/ids";
import {
  getActiveAgentInvocationForConversation,
  getAgentInvocation,
} from "@/chat/agent-invocations/store";
import { finishAgentInvocation } from "@/chat/agent-invocations/finish";
import {
  enqueueAgentInvocationResult,
  withAgentInvocationResultActors,
} from "@/chat/agent-invocations/result";
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
import { agentInstructionProvenance } from "@/chat/conversations/provenance";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import { processConversationQueueMessage } from "@/chat/task-execution/vercel-callback";
import { getTurnRecord } from "@/chat/task-execution/turn-cursor";
import { createConversationWorkHarness } from "../fixtures/conversation-work";
import { context, execute } from "../fixtures/event-automations";
import { createModelAgentRunner } from "../fixtures/agent-runner";
import { createModelStream } from "../fixtures/model-stream";
import { createEventSource } from "@sentry/junior-plugin-api";
import { getCurrentConversationPrivacy } from "@/chat/conversation-privacy";
import {
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
  queueParentTask,
  reportToParent,
  upkeepPlugins,
} from "../fixtures/agent-invocations";
// The parent task that waits behind own work ends with this note.
const nextTaskReply = {
  type: "toolCall" as const,
  name: "noReply",
  arguments: { note: "Checked the next PR." },
};
const nextTaskResult =
  /status="completed">\n[\s\S]*\nChecked the next PR\.\n<\/agent-result>$/;

describe("agent invocation conversation work", () => {
  afterEach(async () => {
    await disconnectStateAdapter();
    vi.restoreAllMocks();
  });

  it("reads the root Location and visibility without delivering child output", async () => {
    const { conversationStore, fixture } =
      await prepareSlackParentConversation();
    let observedVisibility: ReturnType<typeof getCurrentConversationPrivacy>;
    // The child reports with messageAgent. Its final response stays in its
    // own history.
    const agentRunner = createModelAgentRunner(
      createModelStream([
        {
          type: "toolCall",
          name: "messageAgent",
          arguments: { to: "parent", text: "Durable child result" },
          onRequest: () => {
            observedVisibility = getCurrentConversationPrivacy();
          },
        },
        { type: "text", text: "Durable child result" },
      ]),
      { queue: () => queue },
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
          parentToolCallId: "spawn-call",
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
      // The child stores the root's Location and Destination. Only a root
      // delivers to them.
      expect(child).toMatchObject({
        destination: slackDestination,
        location: {
          provider: "slack",
          teamId: "T123",
          channelId: "C123",
          threadTs: "1712345.0001",
        },
        parentConversationId: slackParentConversationId,
        visibility: "public",
      });
      expect(child).not.toHaveProperty("sessionSource");
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
        reportLog: [expect.objectContaining({ text: "Durable child result" })],
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
              /^<agent-result [^>]*status="completed">\n[\s\S]*\nDurable child result\n<\/agent-result>$/,
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
      await finishAgentInvocation({
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
      // A child posts nothing to its Location, so the dashboard reads its
      // input and result from these message events.
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
        // Prompt mode and reportBlocked read this field.
        agentInvocationId: created.invocationId,
        conversationId: created.childConversationId,
        // A parent agent call started it, so its input is an instruction.
        instruction: {
          provenance: agentInstructionProvenance,
          text: expect.stringContaining(slackInvocationInput.input),
        },
        disabledFeatures: ["interactive-auth", "subagents"],
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
  const success = { outcome: "success", type: "turn_completed" };
  // A child reports with a tool. Its final response stays in its history. A
  // parent task gets one result with its reports. The child's own work, such
  // as a Watch Event Run, sends only its messages, failures, and blocks.
  it.each([
    {
      // An open parent task on the same child reports only its own Run, so
      // a failure or block of the child's own work still reports on its own.
      name: "failed own work with an open parent task",
      openParentTask: true,
      outputs: [
        { type: "error" as const, errorMessage: "model unavailable" },
        nextTaskReply,
      ],
      invocation: { errorMessage: "model unavailable", status: "failed" },
      terminal: { failureCode: "model_execution_failed", type: "turn_failed" },
      subagentOutcome: "error",
      parentInputs: [/^<agent-result [^>]*status="failed">/, nextTaskResult],
    },
    {
      // A blocked report is a result, not a model failure.
      name: "blocked own work with an open parent task",
      openParentTask: true,
      outputs: [
        {
          type: "toolCall" as const,
          name: "reportBlocked",
          arguments: { missing: blockedMissing },
        },
        nextTaskReply,
      ],
      invocation: { errorMessage: blockedMissing, status: "blocked" },
      terminal: { outcome: "blocked", type: "turn_completed" },
      subagentOutcome: "blocked",
      parentInputs: [/^<agent-result [^>]*status="blocked">/, nextTaskResult],
    },
    {
      // The failure keeps the report that the Run already sent.
      name: "parent task that fails after a report",
      parentTask: true,
      outputs: [
        reportToParent("Found the cause."),
        { type: "error" as const, errorMessage: "model unavailable" },
      ],
      invocation: { errorMessage: "model unavailable", status: "failed" },
      terminal: { failureCode: "model_execution_failed", type: "turn_failed" },
      subagentOutcome: "error",
      parentInputs: [
        /status="failed">[\s\S]*\nFound the cause\.\n<\/agent-result>$/,
      ],
    },
    {
      // A task steers the Run after its reports, and the Run ends with
      // `noReply`. The earlier reports need no note.
      name: "reported parent task",
      parentTask: true,
      steerTask: "Check the timeout path.",
      outputs: [
        reportToParent("Found the cause."),
        reportToParent("Pushed the fix."),
        { type: "toolCall" as const, name: "noReply", arguments: {} },
      ],
      invocation: { status: "completed" },
      terminal: success,
      subagentOutcome: "success",
      parentInputs: [
        /status="completed">\n[\s\S]*\nFound the cause\.\n\nPushed the fix\.\n<\/agent-result>$/,
      ],
    },
    {
      // A report is the Run's reply, so no text needs to follow it.
      name: "parent task that ends on its report",
      parentTask: true,
      outputs: [
        reportToParent("Pushed the fix."),
        { type: "text" as const, text: "" },
      ],
      invocation: { status: "completed" },
      terminal: success,
      subagentOutcome: "success",
      parentInputs: [/\nPushed the fix\.\n<\/agent-result>$/],
    },
    {
      // The Run ends without a report and gets a reminder. A task that steers
      // it after that reminder gets its own reminder.
      name: "parent task steered after its reminder",
      parentTask: true,
      steerTask: "Check the timeout path.",
      outputs: [
        { type: "text" as const, text: "Looking." },
        { type: "text" as const, text: "Still looking." },
        { type: "text" as const, text: "Checked it." },
        reportToParent("Checked the timeout path."),
        { type: "text" as const, text: "Sent." },
      ],
      invocation: { status: "completed" },
      terminal: success,
      subagentOutcome: "success",
      parentInputs: [/\nChecked the timeout path\.\n<\/agent-result>$/],
    },
    {
      name: "silent parent task",
      parentTask: true,
      outputs: [
        { type: "text" as const, text: "Found the cause." },
        { type: "text" as const, text: "Still found the cause." },
      ],
      invocation: { status: "completed" },
      // The Turn sent no report, so it did not reply.
      terminal: { outcome: "no_reply", type: "turn_completed" },
      subagentOutcome: "success",
      parentInputs: [/ended without sending a report[\s\S]*<\/agent-result>$/],
    },
    {
      // On a parent task, the `noReply` note is the report.
      name: "parent task that ends with a noReply note",
      parentTask: true,
      outputs: [
        {
          type: "toolCall" as const,
          name: "noReply",
          arguments: { note: "No change needed." },
        },
      ],
      invocation: { status: "completed" },
      terminal: success,
      subagentOutcome: "success",
      parentInputs: [
        /status="completed">\n[\s\S]*\nNo change needed\.\n<\/agent-result>$/,
      ],
    },
    {
      // The result cap cuts earlier reports first and keeps the last whole.
      // A `noReply` note is capped like a `messageAgent` report first.
      name: "parent task with reports past the result cap",
      parentTask: true,
      outputs: [
        reportToParent("a".repeat(7_000)),
        reportToParent("Pushed the fix."),
        {
          type: "toolCall" as const,
          name: "noReply",
          arguments: { note: "c".repeat(9_000) },
        },
      ],
      invocation: { status: "completed" },
      terminal: success,
      subagentOutcome: "success",
      parentInputs: [
        /status="completed">\n[\s\S]*\n\[1 earlier report was cut to fit\.\]\n\nPushed the fix\.\n\nc{7999}…\n<\/agent-result>$/,
      ],
    },
    {
      // After a turn-limit stop, the final response is the report, and the
      // reply gate does not ask for another tool call.
      name: "parent task stopped by the turn limit before any report",
      parentTask: true,
      limits: { maxToolCallsPerTurn: 1 },
      outputs: [
        {
          type: "toolCall" as const,
          name: "updatePlan",
          arguments: {
            plan: [{ step: "Find the cause", status: "in_progress" }],
          },
        },
        reportToParent("Found the cause."),
        { type: "text" as const, text: "Out of steps; found the cause." },
      ],
      invocation: { status: "completed" },
      terminal: success,
      subagentOutcome: "success",
      parentInputs: [/\nOut of steps; found the cause\.\n<\/agent-result>$/],
    },
    {
      // Own work sends its final response after a turn-limit stop as one more
      // message, as `messageAgent` would.
      name: "own work stopped by the turn limit",
      limits: { maxToolCallsPerTurn: 1 },
      outputs: [
        reportToParent("<@U123> approved the PR."),
        reportToParent("Checks passed."),
        { type: "text" as const, text: "Out of steps." },
      ],
      invocation: {
        result: "",
        status: "completed",
      },
      terminal: success,
      subagentOutcome: "success",
      parentInputs: [
        /^<agent-message [^>]*>\n[\s\S]*approved the PR\./,
        /^<agent-message [^>]*>\n[\s\S]*\nOut of steps\.\n<\/agent-message>$/,
      ],
    },
    {
      // A tool call after the turn-limit stop ends the Turn. The failure keeps the
      // report that the Run already sent.
      name: "parent task that hits the turn limit after a report",
      parentTask: true,
      limits: { maxToolCallsPerTurn: 1 },
      outputs: [
        reportToParent("Found the cause."),
        reportToParent("Pushed the fix."),
        reportToParent("Pushed the fix."),
      ],
      invocation: {
        errorMessage: expect.stringMatching(/tool call/),
        status: "failed",
      },
      terminal: { type: "turn_failed" },
      subagentOutcome: "error",
      parentInputs: [
        /status="failed">[\s\S]*\nFound the cause\.\n<\/agent-result>$/,
      ],
    },
    {
      // Completed own work owes no result and is not a stop, so the parent
      // task that waits behind it runs and reports alone.
      name: "quiet own work with an open parent task",
      openParentTask: true,
      outputs: [
        {
          type: "toolCall" as const,
          name: "noReply",
          arguments: { note: "Bot comment needs no change." },
        },
        nextTaskReply,
      ],
      invocation: {
        result: "",
        status: "completed",
      },
      terminal: { outcome: "no_reply", type: "turn_completed" },
      subagentOutcome: "success",
      parentInputs: [nextTaskResult],
    },
    {
      name: "own work that messages the parent",
      outputs: [
        reportToParent("<@U123> approved the PR."),
        { type: "toolCall" as const, name: "noReply", arguments: {} },
      ],
      invocation: { status: "completed" },
      // The Turn sent a report, so it replied.
      terminal: success,
      subagentOutcome: "success",
      parentInputs: [/^<agent-message [^>]*>\n[\s\S]*approved the PR\./],
    },
  ])(
    "finishes a $name child Turn after saving its result",
    async ({
      invocation: expectedInvocation,
      limits,
      openParentTask = false,
      outputs,
      parentInputs,
      parentTask = false,
      steerTask,
      subagentOutcome,
      terminal,
    }) => {
      // Each row starts from the default limits.
      await createApp(limits ? { limits } : undefined);
      const { conversationStore, fixture } = await prepareParentConversation();
      // With `steerTask`, a parent task arrives while the second model call
      // runs.
      let childConversationId = "";
      let arrived!: () => void;
      const steeredIn = new Promise<void>((resolve) => (arrived = resolve));
      const steer = async () => {
        await queueParentTask(childConversationId, steerTask!, {
          queue,
          state,
        });
        arrived();
      };
      const {
        queue,
        run: route,
        state,
      } = await createConversationWorkHarness(
        createModelAgentRunner(
          createModelStream(
            outputs.map((output, index) =>
              steerTask && index === 1
                ? {
                    ...output,
                    onRequest: () => void steer(),
                    waitFor: steeredIn,
                  }
                : output,
            ),
          ),
          { queue: () => queue },
        ),
      );
      try {
        const created = await createAndEnqueueAgentInvocation(
          {
            ...invocationInput,
            idempotencyKey: "failed-result-1",
            ...(parentTask ? { parentToolCallId: "spawn-call" } : undefined),
          },
          { conversationStore, queue, state },
        );
        childConversationId = created.childConversationId;
        if (openParentTask) {
          // It waits behind the Run below and runs after it.
          await queueParentTask(childConversationId, "Check the next PR.", {
            queue,
            state,
          });
        }

        await expect(
          processConversationQueueMessage(
            queue.takeMessageFor(created.childConversationId),
            {
              conversationStore,
              queue,
              run: route,
              state,
            },
          ),
        ).resolves.toMatchObject({ status: "completed" });

        await expect(
          getAgentInvocation(created.invocationId),
        ).resolves.toMatchObject(expectedInvocation);
        const parentWork = await getConversationWorkState({
          conversationId: parentConversationId,
          state,
        });
        expect(
          parentWork?.messages.map((message) => message.input.text) ?? [],
        ).toEqual(
          parentInputs.map((pattern) => expect.stringMatching(pattern)),
        );
        // An open parent task runs its own Turn after this one.
        const turnId = getAgentInvocationTurnId(created.invocationId);
        expect(
          (await loadTurnEvents(created.childConversationId)).filter(
            (event) => "turnId" in event.data && event.data.turnId === turnId,
          ),
        ).toEqual([
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
        // A steering task has its own events.
        expect(
          (await loadSubagentEvents(parentConversationId)).filter(
            (event) => event.subagentInvocationId === created.invocationId,
          ),
        ).toEqual([
          expect.objectContaining({ type: "subagent_started" }),
          {
            type: "subagent_ended",
            subagentInvocationId: created.invocationId,
            outcome: subagentOutcome,
          },
        ]);
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
  const resumed = {
    reportLog: [expect.objectContaining({ text: "Resumed child result" })],
    status: "completed",
  };
  it.each([
    {
      name: "a parent task",
      watchEvent: false,
      endBeforeWake: false,
      runs: 2,
      expected: resumed,
      resultSent: true,
    },
    {
      // The report goes out before the yield, and the Run ends with an
      // empty final response after the resume. The earlier report is still
      // its reply.
      name: "a parent task that reports before the yield",
      watchEvent: false,
      reportBeforeYield: true,
      endBeforeWake: false,
      runs: 2,
      expected: {
        reportLog: [expect.objectContaining({ text: "Found the cause." })],
        status: "completed",
      },
      resultSent: true,
    },
    {
      name: "a watch event",
      watchEvent: true,
      endBeforeWake: false,
      runs: 3,
      // The child's own work sends no result.
      expected: { status: "completed" },
      resultSent: false,
    },
    {
      name: "an ended watch event",
      watchEvent: true,
      endBeforeWake: true,
      runs: 2,
      // Failed own work is sent, so the parent knows it never finished.
      expected: { status: "failed" },
      resultSent: true,
    },
    {
      name: "a stopped child",
      watchEvent: false,
      stopBeforeWake: true,
      runs: 1,
      // A stopped child sends nothing.
      expected: { status: "stopped" },
      resultSent: false,
    },
    {
      name: "a resume that keeps failing",
      watchEvent: false,
      // The last try is final, so it fails the invocation, not the work.
      failedResumes: CONVERSATION_WORK_MAX_RETRIES - 1,
      runs: CONVERSATION_WORK_MAX_RETRIES + 1,
      expected: {
        errorMessage: "resume unavailable",
        status: "failed",
      },
      resultSent: true,
    },
  ])(
    "gives the wake after a yielded child invocation for $name to that invocation",
    async ({
      endBeforeWake,
      expected,
      failedResumes = 0,
      reportBeforeYield = false,
      resultSent,
      runs,
      stopBeforeWake = false,
      watchEvent,
    }) => {
      const clock = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
      const markDone = vi.fn((_input: { itemId: string }) => ({}));
      await createApp({ plugins: upkeepPlugins(markDone) });
      const { conversationStore, fixture } = await prepareParentConversation();
      const markDoneCall = {
        type: "toolCall" as const,
        name: "upkeep_markDone",
        arguments: { itemId: "item-7" },
      };
      // The parent task reports. The watch event Run ends with `noReply`.
      const agentRunner = createModelAgentRunner(
        createModelStream([
          ...(watchEvent
            ? [
                reportToParent("Watching"),
                { type: "text" as const, text: "Watching" },
              ]
            : []),
          ...(reportBeforeYield
            ? [
                reportToParent("Found the cause."),
                markDoneCall,
                { type: "text" as const, text: "" },
              ]
            : [
                markDoneCall,
                watchEvent
                  ? {
                      type: "toolCall" as const,
                      name: "noReply",
                      arguments: {},
                    }
                  : reportToParent("Resumed child result"),
                { type: "text" as const, text: "Resumed child result" },
              ]),
        ]),
        { queue: () => queue },
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
            parentToolCallId: "spawn-call",
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
            { after_ms: 60_000, intent: "Check the PR checks." },
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
              toolName: reportBeforeYield ? "messageAgent" : "upkeep_markDone",
            }),
          ]),
        });
        if (endBeforeWake) {
          await finishAgentInvocation({
            errorMessage: "Agent invocation ended",
            invocationId,
            sendResult: async (terminal) =>
              await enqueueAgentInvocationResult(terminal, { queue, state }),
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
        const parentWork = await getConversationWorkState({
          conversationId: parentConversationId,
          state,
        });
        expect(
          parentWork?.messages.some(
            (message) =>
              message.inboundMessageId ===
              getAgentInvocationResultMessageId(invocationId),
          ) ?? false,
        ).toBe(resultSent);
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
});
