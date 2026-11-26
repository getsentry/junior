import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "@/app";
import { createJuniorApi } from "@/api";
import {
  conversationEventPageSchema,
  conversationOutlineSchema,
} from "@/api/schema";
import { spawnChildAgent } from "@/chat/agent-invocations/create";
import {
  getAgentReplyMessageId,
  getParentMessageId,
} from "@/chat/agent-invocations/ids";
import { enqueueStarterUpdate } from "@/chat/agent-invocations/result";
import { withAgentInvocationResultActors } from "@/chat/agent-invocations/result-actors";
import { createEventInboundMessage } from "@/chat/events/notification";
import {
  getCurrentSystemPrompt,
  getCurrentTools,
  type Context,
} from "@earendil-works/pi-ai";
import { stopConversationAndChildAgents } from "@/chat/conversations/stop";
import { bindMessageAgent } from "@/chat/agent-invocations/message";
import { bindSpawnAgent } from "@/chat/agent-invocations/spawn";
import { EVENT_MESSAGE_AUTHOR, EVENT_SYSTEM_ACTOR } from "@/chat/events/actor";
import { createListAgentsTool } from "@/chat/tools/runtime/list-agents";
import { createStopAgentTool } from "@/chat/tools/runtime/stop-agent";
import {
  appendAndEnqueueInboundMessage,
  CONVERSATION_WORK_MAX_RETRIES,
  getConversationWorkState,
} from "@/chat/task-execution/store";
import { loadConversationProjection } from "@/chat/conversations/projection";
import { getConversationEventStore } from "@/chat/db";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import { buildDeterministicTurnId } from "@/chat/state/turn-id";
import { getTurnRecord } from "@/chat/task-execution/turn-cursor";
import { createConversationWorkHarness } from "../fixtures/conversation-work";
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
  expectNoMessageRewrites,
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

/** The Turn that a child's first parent task runs in. */
function parentTaskTurnId(parentId: string, idempotencyKey: string) {
  return buildDeterministicTurnId(getParentMessageId(parentId, idempotencyKey));
}

describe("child agent task work", () => {
  afterEach(async () => {
    await disconnectStateAdapter();
    vi.restoreAllMocks();
  });

  it("reads the root Location and visibility, sends only the final text to the parent, and keeps one prompt on every path", async () => {
    const { conversationStore, fixture } =
      await prepareSlackParentConversation();
    let observedVisibility: ReturnType<typeof getCurrentConversationPrivacy>;
    const modelContexts: Context[] = [];
    const laterReply = (text: string) => ({
      type: "text" as const,
      text,
      onRequest: (context: Context) => modelContexts.push(context),
    });
    const agentRunner = createModelAgentRunner(
      createModelStream([
        {
          type: "text",
          text: "Durable child result",
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
    const { process, queue, state } =
      await createConversationWorkHarness(agentRunner);
    try {
      const { childConversationId } = await spawnChildAgent(
        {
          ...slackInvocationInput,
          idempotencyKey: "execute-1",
          parentToolCallId: "execute-1",
          parentTurnId: "parent-turn",
        },
        { conversationStore, queue, state },
        2_000,
      );
      const taskMessageId = getParentMessageId(
        slackParentConversationId,
        "execute-1",
      );
      const turnId = buildDeterministicTurnId(taskMessageId);
      const child = await conversationStore.get({
        conversationId: childConversationId,
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
      const queueMessage = queue.takeMessageFor(childConversationId);

      await expect(process(queueMessage)).resolves.toMatchObject({
        status: "completed",
      });
      await expect(process(queueMessage)).resolves.toMatchObject({
        status: "no_work",
      });

      // The parent gets the final text once, even after redelivery, as its
      // completed result.
      const parentWork = await getConversationWorkState({
        conversationId: slackParentConversationId,
        state,
      });
      expect(parentWork?.messages).toEqual([
        expect.objectContaining({
          delivery: "defer",
          inboundMessageId: expect.stringMatching(
            `^${getAgentReplyMessageId(childConversationId, turnId)}`,
          ),
          input: expect.objectContaining({
            metadata: expect.objectContaining({
              kind: "event",
              event: expect.objectContaining({
                eventType: "agent.update",
                identifier: childConversationId,
                namespace: "junior",
              }),
              // The reply stores who sent it, so no reader parses its id.
              sender: { conversationId: childConversationId, turnId },
            }),
            text: expect.stringMatching(
              /^<agent-result [^>]*status="done">\n[\s\S]*\nDurable child result\n<\/agent-result>$/,
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
          subagentInvocationId: taskMessageId,
          childConversationId,
        }),
        {
          type: "subagent_ended",
          subagentInvocationId: taskMessageId,
          outcome: "success",
        },
      ]);
      // The parent Turn uses the Actor of the child Turn that sent the
      // reply. A reply that names another parent runs as the Event system
      // Actor.
      const resultMessage = parentWork!.messages[0]!;
      const resultEntry = {
        actor: EVENT_SYSTEM_ACTOR,
        author: EVENT_MESSAGE_AUTHOR,
        message: resultMessage,
        source: createEventSource({
          eventKey: resultMessage.inboundMessageId,
          eventType: "agent.update",
          identifier: childConversationId,
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
      ).resolves.toMatchObject({ batch: [{ actor: EVENT_SYSTEM_ACTOR }] });
      expect(
        (
          await loadConversationProjection({
            conversationId: childConversationId,
          })
        ).messages,
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: "assistant",
            content: [
              expect.objectContaining({
                type: "text",
                text: "Durable child result",
              }),
            ],
          }),
        ]),
      );
      // A child posts nothing to its Location. Its task and its final text
      // are message events in its own transcript.
      await expect(loadMessageEvents(childConversationId)).resolves.toEqual([
        expect.objectContaining({
          type: "message",
          messageId: taskMessageId,
          role: "user",
          text: expect.stringContaining(slackInvocationInput.input),
          meta: expect.objectContaining({
            requestText: slackInvocationInput.input,
          }),
        }),
        expect.objectContaining({
          type: "message",
          role: "assistant",
          text: "Durable child result",
        }),
      ]);
      await expect(loadTurnEvents(childConversationId)).resolves.toEqual([
        expect.objectContaining({
          data: expect.objectContaining({
            inputMessageIds: [taskMessageId],
            turnId,
            type: "turn_started",
          }),
        }),
        expect.objectContaining({
          data: expect.objectContaining({
            outcome: "success",
            turnId,
            type: "turn_completed",
          }),
        }),
      ]);
      // The dashboard shows the task as parent agent input, not as the
      // person who started the root, with the final text as its answer.
      const api = createJuniorApi();
      const childPath = `http://localhost/api/conversations/${encodeURIComponent(childConversationId)}`;
      const outline = conversationOutlineSchema.parse(
        await (await api.request(`${childPath}/outline`)).json(),
      );
      expect(outline.items).toEqual([
        expect.objectContaining({
          agentInvocationId: taskMessageId,
          reply: "Durable child result",
        }),
      ]);
      const eventPage = conversationEventPageSchema.parse(
        await (
          await api.request(
            `${childPath}/events?message=${encodeURIComponent(taskMessageId)}`,
          )
        ).json(),
      );
      expect(eventPage.events.map((event) => event.data)).toContainEqual(
        expect.objectContaining({
          type: "message",
          messageId: taskMessageId,
          agentInvocationId: taskMessageId,
        }),
      );
      expect(run).toHaveBeenCalledOnce();
      expect(run.mock.calls[0]?.[0]).toMatchObject({
        conversationId: childConversationId,
        // The parent agent wrote the task, so it is an instruction with no
        // person behind it.
        instruction: { provenance: { authority: "instruction" } },
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
        source: { kind: "parent_message" },
      });
      expect(run.mock.calls[0]?.[0].instruction.provenance).not.toHaveProperty(
        "actor",
      );
      expect(run.mock.calls[0]?.[0].instruction.text).toContain(
        slackInvocationInput.input,
      );
      expect(observedVisibility).toBe("public");

      // A child Conversation has one prompt cache. A Watch Event and its own
      // child agent's reply run on its Conversation loop, as its task does,
      // and they must send the same system prompt and tools.
      vi.useFakeTimers({ now: Date.now(), toFake: ["Date"] });
      const processChild = async () => {
        // Event input waits for its burst window, as on a root.
        vi.setSystemTime(Date.now() + 60_000);
        await process(queue.takeMessageFor(childConversationId));
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
            conversationId: childConversationId,
            id: "watch-1",
          },
          text: "Deploy failed.",
        }),
        queue,
        state,
      });
      await processChild();
      const helper = await spawnChildAgent(
        {
          ...slackInvocationInput,
          idempotencyKey: "helper-1",
          parentConversationId: childConversationId,
          parentToolCallId: "helper-1",
          parentTurnId: turnId,
        },
        { conversationStore, queue, state },
      );
      await enqueueStarterUpdate({
        actor: slackInvocationInput.actor,
        messageKey: "helper-reply",
        queue,
        update: { status: "done", text: "Helper fact." },
        sender: {
          childConversationId: helper.childConversationId,
          parentConversationId: childConversationId,
        },
        state,
        turnId: "turn_helper",
      });
      await processChild();
      // The helper's result is data, not the person's instruction. The
      // Turn still runs as the person.
      const helperInput = (
        await getConversationEventStore().loadCurrentHistory(
          childConversationId,
        )
      ).find(
        (event) =>
          event.data.type === "user_message" &&
          JSON.stringify(event.data).includes("Helper fact."),
      );
      expect(helperInput?.data).toMatchObject({
        provenance: { authority: "context", actor: slackInvocationInput.actor },
      });
      // A Turn records each input Message once. Its reply is a
      // `message_handled` row, not an edit of the Message.
      await expectNoMessageRewrites(childConversationId);
      expect(
        run.mock.calls.map(([childRun]) => [
          childRun.source.kind,
          childRun.location?.provider,
        ]),
      ).toEqual([
        ["parent_message", "slack"],
        ["event", "slack"],
        ["event", "slack"],
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
      // A person's stop of the parent starts no parent Turn for the unread
      // reply.
      await stopConversationAndChildAgents({
        conversationId: slackParentConversationId,
        nowMs: Date.now(),
        state,
        stoppedAtMs: Date.now(),
      });
      await expect(
        getConversationWorkState({
          conversationId: slackParentConversationId,
          state,
        }),
      ).resolves.toMatchObject({ execution: { pendingMessages: [] } });
    } finally {
      vi.useRealTimers();
      await fixture.close();
    }
  });

  const blockedMissing = "Approval to open the PR. Ask the user.";
  const nothingChanged = {
    type: "text" as const,
    text: "Bot comment needs no change.",
  };
  const finalText = {
    type: "text" as const,
    text: "Draft summary for the parent.",
  };
  const cutOff = (stopReason: "length" | "aborted") => ({
    type: "text" as const,
    text: "Draft summary for the",
    stopReason,
  });
  it.each([
    {
      name: "failed",
      outputs: [{ type: "error" as const, errorMessage: "model unavailable" }],
      terminal: {
        failureCode: "model_execution_failed",
        type: "turn_failed",
      },
      subagentOutcome: "error",
      parentMessages: [
        expect.stringMatching(/status="failed">\n[\s\S]*\nmodel unavailable\n/),
      ],
      // The model error leaves execution idle. The child still lists its
      // failure.
      lastResult: "failed" as const,
    },
    {
      // A Thread tells its parent that the work it gave failed.
      name: "failed thread",
      kind: "thread" as const,
      outputs: [{ type: "error" as const, errorMessage: "model unavailable" }],
      terminal: {
        failureCode: "model_execution_failed",
        type: "turn_failed",
      },
      subagentOutcome: "error",
      parentMessages: [
        expect.stringMatching(/status="failed">\n[\s\S]*\nmodel unavailable\n/),
      ],
      lastResult: "failed" as const,
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
      terminal: { outcome: "blocked", type: "turn_completed" },
      subagentOutcome: "blocked",
      lastResult: "blocked" as const,
      parentMessages: [
        expect.stringMatching(
          /status="blocked">\n[\s\S]*\nApproval to open the PR/,
        ),
      ],
    },
    {
      // A Task that waits on its own Timer still works. Its final text still
      // reports, and the parent decides.
      name: "waiting",
      outputs: [
        {
          type: "toolCall" as const,
          name: "watchTimer",
          arguments: { after_ms: 60_000, intent: "Check the deploy again." },
        },
        nothingChanged,
      ],
      terminal: { outcome: "success", type: "turn_completed" },
      subagentOutcome: "success",
      lastResult: "completed" as const,
      parentMessages: [
        expect.stringMatching(
          /status="done">\n[\s\S]*\nBot comment needs no change\.\n/,
        ),
      ],
    },
    {
      // A Turn that sent its reply before its worker was lost already
      // reported. Its retry sends no second result.
      name: "retry after a reply",
      replied: true,
      outputs: [nothingChanged],
      terminal: { outcome: "success", type: "turn_completed" },
      subagentOutcome: "success",
      lastResult: "completed" as const,
      parentMessages: [
        expect.stringMatching(/status="done">\n[\s\S]*\nLost reply\.\n/),
      ],
    },
    {
      // A Task's final text is its reply. It needs no tool call.
      name: "final text",
      outputs: [finalText],
      terminal: { outcome: "success", type: "turn_completed" },
      subagentOutcome: "success",
      lastResult: "completed" as const,
      parentMessages: [
        expect.stringMatching(
          /status="done">\n[\s\S]*\nDraft summary for the parent\.\n/,
        ),
      ],
    },
    {
      name: "final text thread",
      kind: "thread" as const,
      outputs: [finalText],
      terminal: { outcome: "success", type: "turn_completed" },
      subagentOutcome: "success",
      lastResult: "completed" as const,
      parentMessages: [
        expect.stringMatching(
          /status="done">\n[\s\S]*\nDraft summary for the parent\.\n/,
        ),
      ],
    },
    {
      // Final text that the output limit cut off is a failure, not a reply.
      name: "cut off",
      // The cut-off text is not delivered.
      undelivered: ["Draft summary for the"],
      outputs: [cutOff("length")],
      terminal: {
        failureCode: "model_execution_failed",
        type: "turn_failed",
      },
      subagentOutcome: "error",
      parentMessages: [
        expect.stringMatching(
          /status="failed">\n[\s\S]*\nThe final text was cut off at the model's output length limit\.\n/,
        ),
      ],
      lastResult: "failed" as const,
    },
    {
      name: "aborted thread",
      // The cut-off text is not delivered.
      undelivered: ["Draft summary for the"],
      kind: "thread" as const,
      outputs: [cutOff("aborted")],
      terminal: {
        failureCode: "model_execution_failed",
        type: "turn_failed",
      },
      subagentOutcome: "error",
      parentMessages: [
        expect.stringMatching(
          /status="failed">\n[\s\S]*\nThe final text was cut off when the model request was aborted\.\n/,
        ),
      ],
      lastResult: "failed" as const,
    },
  ])(
    "finishes a $name child Turn after saving its result",
    async ({
      kind,
      lastResult,
      outputs,
      parentMessages,
      replied,
      subagentOutcome,
      terminal,
      undelivered = [],
    }) => {
      const { conversationStore, fixture } = await prepareParentConversation();
      const modelStream = vi.fn(createModelStream(outputs));
      const { process, queue, state } = await createConversationWorkHarness(
        createModelAgentRunner(modelStream),
      );
      try {
        const { childConversationId } = await spawnChildAgent(
          {
            ...invocationInput,
            idempotencyKey: "failed-result-1",
            parentToolCallId: "failed-result-1",
            parentTurnId: "parent-turn",
            ...(kind ? { kind } : undefined),
          },
          { conversationStore, queue, state },
        );
        const turnId = parentTaskTurnId(
          parentConversationId,
          "failed-result-1",
        );
        if (replied) {
          await enqueueStarterUpdate({
            actor: invocationInput.actor,
            messageKey: turnId,
            queue,
            update: { status: "done", text: "Lost reply." },
            sender: { childConversationId, parentConversationId },
            state,
            turnId,
          });
        }

        await expect(
          process(queue.takeMessageFor(childConversationId)),
        ).resolves.toMatchObject({ status: "completed" });

        expect(modelStream).toHaveBeenCalledTimes(outputs.length);
        const delivered = JSON.stringify(
          await loadMessageEvents(childConversationId),
        );
        expect(undelivered.filter((text) => delivered.includes(text))).toEqual(
          [],
        );
        await expect(loadTurnEvents(childConversationId)).resolves.toEqual([
          expect.objectContaining({
            data: expect.objectContaining({ type: "turn_started", turnId }),
          }),
          expect.objectContaining({
            data: expect.objectContaining({ ...terminal, turnId }),
          }),
        ]);
        await expect(loadSubagentEvents(parentConversationId)).resolves.toEqual(
          [
            expect.objectContaining({ type: "subagent_started" }),
            {
              type: "subagent_ended",
              subagentInvocationId: getParentMessageId(
                parentConversationId,
                "failed-result-1",
              ),
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
        const { agents } = await createListAgentsTool({
          conversationId: parentConversationId,
        }).execute!({}, {});
        expect(agents).toEqual([expect.objectContaining({ status: "idle" })]);
        expect(agents[0]!.last_result).toBe(lastResult);
      } finally {
        await fixture.close();
      }
    },
  );

  // When a child's Turn yields, the next wake must resume that Turn, also
  // when the child was stopped while its Turn stayed paused. A resume wake
  // has no messages, but its last try is still final, so a resume that keeps
  // failing tells the parent.
  const resumed = [expect.stringContaining("Resumed child result")];
  it.each([
    {
      name: "a parent task",
      runs: 2,
      parentMessages: resumed,
    },
    {
      // The swap keeps the earlier Turn's answer after the mark. It belongs
      // to that Turn, so the resumed slice still calls the model.
      name: "a child that swapped in a summary at Turn start",
      earlierAnswer: true,
      runs: 2,
      parentMessages: resumed,
    },
    {
      // The fork history holds the parent's answer, but not this Turn's.
      name: "a fork child",
      fork: true,
      runs: 2,
      parentMessages: resumed,
    },
    {
      // A worker that committed fork history after the Turn start stopped
      // before it committed any. The history must not join the Turn.
      name: "a fork child whose Turn started before its history",
      fork: true,
      turnStartedFirst: true,
      runs: 2,
      parentMessages: resumed,
    },
    {
      // The parent stopped the child, so it gets no result.
      name: "a stopped child",
      stopBeforeWake: true,
      runs: 1,
      parentMessages: [],
    },
    {
      name: "a resume that keeps failing",
      failedResumes: CONVERSATION_WORK_MAX_RETRIES - 1,
      runs: CONVERSATION_WORK_MAX_RETRIES + 1,
      parentMessages: [
        expect.stringMatching(/status="failed"[\s\S]*resume unavailable/),
      ],
    },
  ])(
    "resumes a yielded child Turn for $name",
    async ({
      earlierAnswer = false,
      fork = false,
      failedResumes = 0,
      parentMessages,
      runs,
      stopBeforeWake = false,
      turnStartedFirst = false,
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
          { type: "text", text: "Resumed child result" },
        ]),
      );
      const run = vi.spyOn(agentRunner, "run");
      const { process, queue, state } =
        await createConversationWorkHarness(agentRunner);
      try {
        const { childConversationId } = await spawnChildAgent(
          {
            ...invocationInput,
            idempotencyKey: "resume-1",
            parentToolCallId: fork
              ? await prepareForkParentHistory()
              : "resume-1",
            parentTurnId: "parent-turn",
            ...(fork ? { fork } : undefined),
          },
          { conversationStore, queue, state },
        );
        const turnId = parentTaskTurnId(parentConversationId, "resume-1");
        if (earlierAnswer) {
          await prepareSummarizedHistory(childConversationId);
        }
        if (turnStartedFirst) {
          await recordTurnStart(childConversationId, turnId);
        }
        // Child results also wake the parent. This test runs only the child.
        const processChild = async (softYieldAfterMs?: number) =>
          await process(
            queue.takeMessageFor(childConversationId),
            softYieldAfterMs === undefined ? {} : { softYieldAfterMs },
          );
        await expect(processChild(0)).resolves.toMatchObject({
          status: "yielded",
        });
        const paused = (await getTurnRecord(childConversationId, turnId))!;
        expect(paused).toMatchObject({
          state: "paused",
          resumeReason: "yield",
          source: { kind: "parent_message" },
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
          // The stop request outlives the paused run. The stopped child
          // takes the resume wake and does not run again.
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
        const parentWork = await getConversationWorkState({
          conversationId: parentConversationId,
          state,
        });
        expect(
          (parentWork?.messages ?? []).map((message) => message.input.text),
        ).toEqual(parentMessages);
        // An ended child leaves no paused Turn that a later wake could resume.
        await expect(
          getTurnRecord(childConversationId, turnId),
        ).resolves.not.toMatchObject({ state: "paused" });
        const projection = (
          await loadConversationProjection({
            conversationId: childConversationId,
          })
        ).messages;
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
