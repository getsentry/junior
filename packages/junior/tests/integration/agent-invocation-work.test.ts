import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "@/app";
import type { PiMessage } from "@/chat/pi/messages";
import { createAgentInvocation } from "@/chat/agent-invocations/create";
import {
  getAgentInvocationMessageId,
  getAgentInvocationTurnId,
} from "@/chat/agent-invocations/ids";
import {
  completeAgentInvocation,
  getActiveAgentInvocationForConversation,
  getAgentInvocation,
} from "@/chat/agent-invocations/store";
import {
  enqueueChildResultToParent,
  withAgentInvocationResultActors,
} from "@/chat/agent-invocations/result";
import { createEventInboundMessage } from "@/chat/events/notification";
import {
  getCurrentSystemPrompt,
  getCurrentTools,
  type Context,
} from "@earendil-works/pi-ai";
import { stopChildAgentsBelow } from "@/chat/agent-invocations/stop";
import { bindMessageAgent } from "@/chat/agent-invocations/message";
import { bindSpawnAgent } from "@/chat/agent-invocations/spawn";
import { EVENT_MESSAGE_AUTHOR, EVENT_SYSTEM_ACTOR } from "@/chat/events/actor";
import { createStopAgentTool } from "@/chat/tools/runtime/stop-agent";
import {
  appendAndEnqueueInboundMessage,
  CONVERSATION_WORK_MAX_RETRIES,
  getConversationWorkState,
} from "@/chat/task-execution/store";
import { createAndEnqueueAgentInvocation } from "@/chat/agent-invocations/work";
import { loadProjection } from "@/chat/conversations/projection";
import { getConversationEventStore } from "@/chat/db";
import { contextProvenance } from "@/chat/conversations/provenance";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import { processConversationQueueMessage } from "@/chat/task-execution/vercel-callback";
import {
  getTurnRecord,
  upsertTurnRecord,
} from "@/chat/task-execution/turn-cursor";
import { createConversationWorkHarness } from "../fixtures/conversation-work";
import {
  createModelAgentRunner,
  neverRunAgentRunner,
} from "../fixtures/agent-runner";
import { createModelStream } from "../fixtures/model-stream";
import { createEventSource } from "@sentry/junior-plugin-api";
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
  prepareForkParentHistory,
  prepareSummarizedHistory,
  upkeepPlugins,
} from "../fixtures/agent-invocations";
import { recordTurnStart } from "../fixtures/turn-start";
import { loadTurnStart } from "@/chat/conversations/turn-lifecycle";
import { savedTurnMessages } from "@/chat/task-execution/turn-membership";

describe("agent invocation conversation work", () => {
  afterEach(async () => {
    await disconnectStateAdapter();
    vi.restoreAllMocks();
  });

  it("reads the root Location and visibility, sends only the reply to the parent, and keeps one prompt on every path", async () => {
    const { conversationStore, fixture } =
      await prepareSlackParentConversation();
    let observedVisibility: ReturnType<typeof getCurrentConversationPrivacy>;
    const modelContexts: Context[] = [];
    const laterReply = (text: string) => ({
      type: "toolCall" as const,
      name: "reply",
      arguments: { text },
      onRequest: (context: Context) => modelContexts.push(context),
    });
    const agentRunner = createModelAgentRunner(
      createModelStream([
        {
          type: "toolCall",
          name: "reply",
          arguments: { text: "Durable child result" },
          onRequest: (context) => {
            observedVisibility = getCurrentConversationPrivacy();
            modelContexts.push(context);
          },
        },
        laterReply("Watch Event result"),
        laterReply("Helper result"),
      ]),
      {
        bindMessageAgent: (childRun) =>
          bindMessageAgent(childRun, { queue: () => queue }),
        bindSpawnAgent: (childRun) =>
          bindSpawnAgent(childRun, { queue: () => queue }),
      },
    );
    const run = vi.spyOn(agentRunner, "run");
    const {
      process,
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
        parentMailboxStatus: "appended",
        result: "Durable child result",
        status: "completed",
        terminalAtMs: expect.any(Number),
      });
      // The parent gets the reply once, even after redelivery, and no
      // completed result.
      const parentWork = await getConversationWorkState({
        conversationId: slackParentConversationId,
        state,
      });
      expect(parentWork?.messages).toEqual([
        expect.objectContaining({
          delivery: "defer",
          inboundMessageId: expect.stringMatching(
            `^agent-reply:${created.invocationId}:`,
          ),
          input: expect.objectContaining({
            metadata: {
              kind: "event",
              event: expect.objectContaining({
                eventType: "agent.reply",
                identifier: created.invocationId,
                namespace: "junior",
              }),
              // The reply stores who sent it, so no reader parses its id.
              sender: {
                agentInvocationId: created.invocationId,
                conversationId: created.childConversationId,
                turnId: getAgentInvocationTurnId(created.invocationId),
              },
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
          eventKey: resultMessage.inboundMessageId,
          eventType: "agent.reply",
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
                type: "toolCall",
                name: "reply",
                arguments: { text: "Durable child result" },
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
        // No parent agent call started it, so its input is not an
        // instruction.
        instruction: {
          provenance: contextProvenance,
          text: slackInvocationInput.input,
        },
        disabledFeatures: ["interactive-auth"],
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

      // A child Conversation has one prompt cache. A Watch Event and its own
      // child agent's reply run on its Conversation loop, not on an Agent
      // invocation, and they must send the same system prompt and tools.
      vi.useFakeTimers({ now: Date.now(), toFake: ["Date"] });
      const processChild = async () => {
        // Event input waits for its burst window, as on a root.
        vi.setSystemTime(Date.now() + 60_000);
        await process(queue.takeMessageFor(created.childConversationId));
      };
      await appendAndEnqueueInboundMessage({
        message: createEventInboundMessage({
          event: {
            eventKey: "deploy-1",
            eventType: "deployment.failed",
            identifier: "getsentry/junior",
            namespace: "github",
            occurredAtMs: Date.now(),
            trustedSummary: "A deployment failed.",
          },
          subscription: {
            conversationId: created.childConversationId,
            id: "watch-1",
          },
          text: "Deploy failed.",
        }),
        queue,
        state,
      });
      await processChild();
      const helper = await createAgentInvocation({
        ...slackInvocationInput,
        idempotencyKey: "helper-1",
        parentConversationId: created.childConversationId,
      });
      await enqueueChildResultToParent({
        actor: helper.actor,
        messageKey: "helper-reply",
        queue,
        result: {
          kind: "reply",
          reply: { text: "Helper fact.", toolCallId: "helper-reply" },
        },
        sender: helper,
        state,
        turnId: getAgentInvocationTurnId(helper.invocationId),
      });
      await processChild();
      expect(
        run.mock.calls.map(([childRun]) => [
          childRun.source.kind,
          childRun.agentInvocationId === undefined,
          childRun.location?.provider,
        ]),
      ).toEqual([
        ["agent_invocation", false, "slack"],
        ["event", true, "slack"],
        ["event", true, "slack"],
      ]);
      // The model stream reads each request as a transcript.
      const definitions = modelContexts.map(({ messages }) => ({
        systemPrompt: getCurrentSystemPrompt(messages),
        tools: getCurrentTools(messages).map((tool) => tool.name),
      }));
      expect(definitions).toHaveLength(3);
      expect(definitions[0]!.systemPrompt).not.toBe("");
      expect(definitions[1]).toEqual(definitions[0]);
      expect(definitions[2]).toEqual(definitions[0]);
      // A person's stop of the parent skips the unread reply, as it skips a
      // result, so it starts no parent Turn.
      await stopChildAgentsBelow(slackParentConversationId, {
        nowMs: Date.now(),
        stoppedAtMs: Date.now(),
        state,
      });
      await expect(
        withAgentInvocationResultActors({
          kind: "mailbox",
          batch: [resultEntry],
        }),
      ).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
      await fixture.close();
    }
  });

  it("makes a child private when its root's channel goes private", async () => {
    const { conversationStore, fixture } =
      await prepareSlackParentConversation();
    try {
      const created = await createAgentInvocation({
        ...slackInvocationInput,
        idempotencyKey: "private-1",
      });
      const childBefore = await conversationStore.get({
        conversationId: created.childConversationId,
      });
      expect(childBefore).toMatchObject({ visibility: "public" });

      // Only the root records the new visibility. The child shares its
      // Destination row, so its own row does not change. A child Run reads
      // this visibility, as the test above shows.
      await conversationStore.recordActivity({
        conversationId: slackParentConversationId,
        destination: slackDestination,
        nowMs: 3_000,
        source: "slack",
        visibility: "private",
      });
      await expect(
        conversationStore.get({ conversationId: created.childConversationId }),
      ).resolves.toEqual({ ...childBefore, visibility: "private" });
    } finally {
      await fixture.close();
    }
  });

  const blockedMissing = "Approval to open the PR. Ask the user.";
  // Plain text in a child Turn is not an answer. It gets one reminder.
  const plainText = [
    { type: "text" as const, text: "Draft summary for the parent." },
    { type: "text" as const, text: "Draft summary for the parent." },
  ];
  it.each([
    {
      name: "failed",
      outputs: [{ type: "error" as const, errorMessage: "model unavailable" }],
      invocation: { errorMessage: "model unavailable", status: "failed" },
      terminal: { failureCode: "model_execution_failed", type: "turn_failed" },
      subagentOutcome: "error",
      parentMessages: [
        expect.stringMatching(/status="failed">\n[\s\S]*\nmodel unavailable\n/),
      ],
    },
    {
      // A blocked report is a result, not a model failure.
      name: "blocked",
      outputs: [
        {
          type: "toolCall" as const,
          name: "reportBlocked",
          arguments: { missing: blockedMissing },
        },
      ],
      invocation: { errorMessage: blockedMissing, status: "blocked" },
      terminal: { outcome: "blocked", type: "turn_completed" },
      subagentOutcome: "blocked",
      parentMessages: [
        expect.stringMatching(
          /status="blocked">\n[\s\S]*\nApproval to open the PR/,
        ),
      ],
    },
    {
      // The note stays in the child. The parent gets nothing.
      name: "quiet",
      outputs: [
        {
          type: "toolCall" as const,
          name: "noReply",
          arguments: { note: "Bot comment needs no change." },
        },
      ],
      invocation: { result: "", status: "completed" },
      terminal: { outcome: "no_reply", type: "turn_completed" },
      subagentOutcome: "success",
      parentMessages: [],
    },
    {
      // A Task's parent learns that no reply was sent, without the text.
      name: "unanswered task",
      outputs: plainText,
      invocation: { errorMessage: "No reply was sent.", status: "failed" },
      terminal: { failureCode: "model_execution_failed", type: "turn_failed" },
      subagentOutcome: "error",
      parentMessages: [
        expect.stringMatching(
          /status="failed">\n[\s\S]*\nNo reply was sent\.\n/,
        ),
      ],
    },
    {
      // A Thread stays quiet.
      name: "unanswered thread",
      kind: "thread" as const,
      outputs: plainText,
      invocation: { result: "", status: "completed" },
      terminal: { outcome: "no_reply", type: "turn_completed" },
      subagentOutcome: "success",
      parentMessages: [],
    },
  ])(
    "finishes a $name child Turn after saving its result",
    async ({
      invocation: expectedInvocation,
      kind,
      outputs,
      parentMessages,
      subagentOutcome,
      terminal,
    }) => {
      const { conversationStore, fixture } = await prepareParentConversation();
      const modelStream = vi.fn(createModelStream(outputs));
      const {
        queue,
        run: route,
        state,
      } = await createConversationWorkHarness(
        createModelAgentRunner(modelStream),
      );
      try {
        const created = await createAndEnqueueAgentInvocation(
          {
            ...invocationInput,
            idempotencyKey: "failed-result-1",
            ...(kind ? { kind } : undefined),
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

        expect(modelStream).toHaveBeenCalledTimes(outputs.length);
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
        const parentWork = await getConversationWorkState({
          conversationId: parentConversationId,
          state,
        });
        expect(
          (parentWork?.messages ?? []).map((message) => message.input.text),
        ).toEqual(parentMessages);
      } finally {
        await fixture.close();
      }
    },
  );

  // When an agent invocation's Turn yields, the next wake must still reach
  // that agent invocation, also when it was stopped while its Turn stayed
  // paused. A resume wake has no messages, but its last try is still final,
  // so a resume that keeps failing tells the parent.
  const resumed = { result: "Resumed child result", status: "completed" };
  it.each([
    {
      name: "a parent task",
      runs: 2,
      expected: resumed,
    },
    {
      // The swap keeps the earlier Turn's answer after the mark. It belongs
      // to that Turn, so the resumed slice still calls the model.
      name: "a child that swapped in a summary at Turn start",
      earlierAnswer: true,
      runs: 2,
      expected: resumed,
    },
    {
      // The fork history holds the parent's answer, but not this Turn's.
      name: "a fork child",
      fork: true,
      runs: 2,
      expected: resumed,
    },
    {
      name: "a stopped child",
      stopBeforeWake: true,
      runs: 1,
      expected: { parentMailboxStatus: "skipped", status: "stopped" },
    },
    {
      name: "a resume that keeps failing",
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
      earlierAnswer = false,
      expected,
      fork = false,
      failedResumes = 0,
      runs,
      stopBeforeWake = false,
    }) => {
      const clock = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
      const markDone = vi.fn((_input: { itemId: string }) => ({}));
      await createApp({ plugins: upkeepPlugins(markDone) });
      const { conversationStore, fixture } = await prepareParentConversation();
      const agentRunner = createModelAgentRunner(
        createModelStream([
          {
            type: "toolCall",
            name: "upkeep_markDone",
            arguments: { itemId: "item-7" },
          },
          {
            type: "toolCall",
            name: "reply",
            arguments: { text: "Resumed child result" },
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
            ...invocationInput,
            idempotencyKey: "resume-1",
            ...(fork
              ? { fork, parentToolCallId: await prepareForkParentHistory() }
              : undefined),
          },
          { conversationStore, queue, state },
        );
        const { childConversationId } = created;
        if (earlierAnswer) {
          await prepareSummarizedHistory(childConversationId);
        }
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
        await expect(processChild(0)).resolves.toMatchObject({
          status: "yielded",
        });
        const { invocationId } =
          (await getActiveAgentInvocationForConversation(childConversationId))!;
        const turnId = getAgentInvocationTurnId(invocationId);
        const paused = (await getTurnRecord(childConversationId, turnId))!;
        expect(paused).toMatchObject({
          state: "paused",
          resumeReason: "yield",
          source: { kind: "agent_invocation" },
          piMessages: expect.arrayContaining([
            expect.objectContaining({
              role: "toolResult",
              toolName: "upkeep_markDone",
            }),
          ]),
        });
        // The paused Turn has no answer yet. An earlier Turn's answer is
        // below its start.
        const turnStart = await loadTurnStart(childConversationId, turnId);
        expect(
          savedTurnMessages(paused, turnStart).map(({ message }) => message),
        ).not.toContainEqual(expect.objectContaining({ toolName: "reply" }));
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
      // The reply reached the parent before the Turn was saved.
      name: "a reply",
      tail: [
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "tool-2",
              name: "reply",
              arguments: { text: "Recovered visible result" },
            },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "tool-2",
          toolName: "reply",
          content: [{ type: "text", text: "Recovered visible result" }],
          details: { text: "Recovered visible result" },
          isError: false,
        },
      ],
      expected: { result: "Recovered visible result", status: "completed" },
      turnOutcome: "success",
    },
    {
      // A Turn saved before `reply` existed ends with its final text, for
      // one release.
      name: "final text",
      tail: [
        {
          role: "assistant",
          content: [{ type: "text", text: "Recovered final text" }],
        },
      ],
      expected: { result: "Recovered final text", status: "completed" },
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
        await recordTurnStart(
          created.childConversationId,
          getAgentInvocationTurnId(created.invocationId),
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
            data: expect.objectContaining({ type: "turn_started" }),
          }),
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
