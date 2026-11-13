import { getAgentInvocationTurnId } from "@/chat/agent-invocations/ids";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createOrGetDispatch,
  getDispatchConversationId,
  getDispatchInputMessageId,
  getDispatchRecord,
  getDispatchStorageKey,
  getDispatchTurnId,
} from "@/chat/agent-dispatch/store";
import { enqueueAgentDispatch } from "@/chat/agent-dispatch/work";
import { recordAutomationExecution } from "@/chat/automations/execution-stats";
import { createAgentInvocation } from "@/chat/agent-invocations/create";
import { enqueueChildResultToParent } from "@/chat/agent-invocations/result";
import { upsertIdentity } from "@/chat/identities/sql";
import {
  readScheduledAutomation,
  saveScheduledAutomation,
} from "@/chat/scheduled-automations/tasks";
import { createEventInboundMessage } from "@/chat/events/notification";
import { appendAndEnqueueInboundMessage } from "@/chat/task-execution/store";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import { processConversationQueueMessage } from "@/chat/task-execution/vercel-callback";
import { turnCursorKey } from "@/chat/task-execution/turn-cursor-keys";
import { getTurnRecord } from "@/chat/task-execution/turn-cursor";
import {
  LOST_WORKER_RESUME_MESSAGE,
  saveTurnCheckpoint,
} from "@/chat/task-execution/checkpoint";
import {
  hydrateConversationMessages,
  persistConversationMessages,
} from "@/chat/conversations/messages";
import { coerceThreadConversationState } from "@/chat/state/conversation";
import { getUserMessageInstructionText } from "@/chat/pi/transcript";
import { getConversationStore, getDb, getSqlExecutor } from "@/chat/db";
import { slackApiOutbox } from "../fixtures/slack-api-outbox";
import {
  queueSlackApiResponse,
  resetSlackApiMockState,
} from "../msw/handlers/slack-api";
import { chatPostMessageOk } from "../fixtures/slack/factories/api";
import { createModelStream } from "../fixtures/model-stream";
import {
  createModelAgentRunner,
  neverRunAgentRunner,
} from "../fixtures/agent-runner";
import {
  mockTitleModel,
  type TitleModelRequest,
} from "../fixtures/title-model";
import {
  agentDispatchTestDestination as destination,
  createAgentDispatchTestRecord as createDispatch,
} from "../fixtures/agent-dispatch";
import {
  createConversationWorkHarness,
  handleSlackWebhookAndFlush,
  SLACK_BOT_USER_ID,
  slackEnvelope,
  slackWebhookRequest,
} from "../fixtures/conversation-work";

vi.hoisted(() => {
  process.env.JUNIOR_STATE_ADAPTER = "memory";
});

/** Model output that ends an Automation run with a `reply` call. */
function sendMessage(message: string) {
  return {
    type: "toolCall" as const,
    name: "reply",
    arguments: { text: message },
  };
}

describe("agent dispatch conversation work", () => {
  beforeEach(async () => {
    await disconnectStateAdapter();
    resetSlackApiMockState();
    // Every run generates a Conversation title.
    mockTitleModel("Scheduled digest run");
  });

  afterEach(async () => {
    await disconnectStateAdapter();
    vi.restoreAllMocks();
  });

  it("preserves plain dispatch input without Markdown serialization", async () => {
    const input = "Post snake_case as written.\n- Keep this bullet.";
    const dispatch = await createDispatch(
      "plain-input",
      undefined,
      undefined,
      undefined,
      input,
    );
    const modelStream = vi.fn(createModelStream([sendMessage("Done")]));
    const { queue, run, state } = await createConversationWorkHarness(
      createModelAgentRunner(modelStream),
    );

    // The title model returns no title, so run title generation fails.
    mockTitleModel("");
    await enqueueAgentDispatch(dispatch, { queue, state });
    const titleWork: Promise<unknown>[] = [];
    await processConversationQueueMessage(queue.takeMessage(), {
      queue,
      run,
      state,
      waitUntil: (work) => titleWork.push(work),
    });
    await Promise.all(titleWork);

    // A failed run title stays unset, so the dashboard keeps its fallback label.
    const untitled = await getConversationStore().get({
      conversationId: getDispatchConversationId(dispatch),
    });
    expect(untitled?.title).toBeUndefined();
    expect(untitled?.kind).toBe("automation");
    expect(slackApiOutbox.messages()).toEqual([
      expect.objectContaining({
        params: expect.objectContaining({ text: "Done" }),
      }),
    ]);
    await expect(
      state.get(
        turnCursorKey(
          getDispatchConversationId(dispatch),
          getDispatchTurnId(dispatch.id),
        ),
      ),
    ).resolves.toMatchObject({
      dispatchId: dispatch.id,
      publishExternally: true,
    });
    expect(modelStream).toHaveBeenCalledOnce();
    const instruction = modelStream.mock.calls[0]?.[1].messages.at(-1);
    if (!instruction) {
      throw new Error("Expected one model instruction");
    }
    expect(getUserMessageInstructionText(instruction)).toMatchInlineSnapshot(`
      "Post snake_case as written.
      - Keep this bullet."
    `);
  }, 15_000);

  it("runs enqueued dispatch work through production routing with exact authority", async () => {
    const store = getConversationStore();
    // A live Slack event saw the channel as private after the Automation saved
    // its public visibility.
    await store.recordActivity({
      conversationId: "slack:C123:1700000000.000300",
      destination,
      source: "slack",
      visibility: "private",
    });
    const { record: dispatch } = await createOrGetDispatch({
      nowMs: Date.now(),
      options: {
        destination,
        destinationVisibility: "public",
        idempotencyKey: "shared-runtime",
        input: "Post the scheduled digest.",
        replyAttribution: { label: "Scheduled automation", detail: "Weekly" },
        source: { kind: "scheduled_automation" },
      },
      plugin: "scheduler",
    });
    const agentRunner = createModelAgentRunner(
      createModelStream([sendMessage("Scheduled digest")]),
    );
    const run = vi.spyOn(agentRunner, "run");
    const {
      queue,
      run: runWork,
      state,
    } = await createConversationWorkHarness(agentRunner);

    const titleRequests: TitleModelRequest[] = [];
    mockTitleModel("Weekly digest for the platform team", {
      onRequest: (request) => titleRequests.push(request),
    });
    const conversationId = getDispatchConversationId(dispatch);
    const titleWork: Promise<unknown>[] = [];
    const waitUntil = (work: Promise<unknown>) => titleWork.push(work);

    await enqueueAgentDispatch(dispatch, { queue, state });
    const queueMessage = queue.takeMessage();
    await processConversationQueueMessage(queueMessage, {
      queue,
      run: runWork,
      state,
      waitUntil,
    });
    await processConversationQueueMessage(queueMessage, {
      queue,
      run: runWork,
      state,
      waitUntil,
    });
    await Promise.all(titleWork);

    // The run input is the title source because no human message exists.
    const titled = await store.get({ conversationId });
    expect(titled?.title).toBe("Weekly digest for the platform team");
    expect(JSON.stringify(titleRequests[0]?.messages)).toContain(
      "Task input: Post the scheduled digest.",
    );
    expect(queue.hasQueuedMessages()).toBe(false);
    expect(slackApiOutbox.messages()).toHaveLength(1);
    expect(slackApiOutbox.messages()[0]?.params).toMatchObject({
      channel: destination.channelId,
      text: "Scheduled digest\n\nScheduled automation · Weekly",
    });
    await expect(getDispatchRecord(dispatch.id)).resolves.toMatchObject({
      resultMessageTs: expect.any(String),
      status: "completed",
    });
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0]?.[0]).toMatchObject({
      conversationId: `agent-dispatch:${dispatch.id}`,
      turnId: `dispatch:${dispatch.id}`,
      actor: { platform: "system", name: "scheduler" },
      credentialContext: {
        actor: { platform: "system", name: "scheduler" },
      },
      destination,
      dispatch: {
        id: dispatch.id,
        plugin: "scheduler",
        replyAttribution: {
          label: "Scheduled automation",
          detail: "Weekly",
        },
      },
      source: { kind: "scheduled_automation" },
      surface: "api",
      disabledFeatures: ["interactive-auth"],
    });
    // Only live provider signals refresh the visibility that the channel's
    // Conversations share.
    await expect(
      store.getDestinationVisibility({
        provider: "slack",
        providerDestinationId: destination.channelId,
        providerTenantId: destination.teamId,
      }),
    ).resolves.toBe("private");
  }, 15_000);

  it("replies in the run's thread on later Watch, child result, and person Turns", async () => {
    const creatorIdentityId = (
      await upsertIdentity(getSqlExecutor(), {
        kind: "user",
        provider: "slack",
        providerTenantId: destination.teamId,
        providerSubjectId: "U123",
      })
    ).id;
    const threadDestination = { ...destination, threadTs: "1700000000.000200" };
    await saveScheduledAutomation(getDb(), {
      id: "sched_watch_follow_up",
      conversationAccess: { audience: "channel", visibility: "public" },
      createdAtMs: Date.now(),
      createdBy: { slackUserId: "U123" },
      creatorIdentityId,
      credentialMode: "system",
      destination,
      outcomes: [{ action: "send_message", destination }],
      nextRunAtMs: Date.now() + 86_400_000,
      schedule: {
        description: "Daily at noon UTC",
        kind: "recurring",
        timezone: "UTC",
        recurrence: {
          frequency: "daily",
          interval: 1,
          startDate: "2026-01-01",
          time: { hour: 12, minute: 0 },
        },
      },
      status: "active",
      task: { kind: "instruction", instruction: "Post the scheduled digest." },
      updatedAtMs: Date.now(),
    });
    const dispatch = await createDispatch(
      "outcome-thread-binding",
      undefined,
      { kind: "scheduled_automation", automationId: "sched_watch_follow_up" },
      undefined,
      "Post the scheduled digest.",
      [{ action: "send_message", destination: threadDestination }],
      threadDestination,
    );
    const conversationId = getDispatchConversationId(dispatch);
    const modelStream = vi.fn(
      createModelStream([
        sendMessage("Scheduled digest"),
        // A Watch Event Turn's final response is not delivered.
        { type: "text", text: "Checking the merged change." },
        sendMessage("The change merged."),
        { type: "toolCall", name: "noReply", arguments: {} },
        // A Turn without an answer gets one re-ask, then posts nothing.
        { type: "text", text: "Checks are still running." },
        { type: "text", text: "Checks are still running." },
        sendMessage("The child agent finished."),
        // A person's Turn is not gated, so its final response is delivered.
        { type: "text", text: "The digest is up to date." },
        {
          type: "toolCall",
          name: "reportBlocked",
          arguments: { missing: "The digest repository was archived." },
        },
      ]),
    );
    const { adapter, queue, run, runtime, state } =
      await createConversationWorkHarness(createModelAgentRunner(modelStream));
    const processNext = async () =>
      await processConversationQueueMessage(queue.takeMessage(), {
        queue,
        run,
        state,
      });
    const threadPosts = () =>
      slackApiOutbox
        .messages()
        .filter((message) => message.params.thread_ts === "1700000000.000200")
        .map((message) => message.params.text);
    const watchEvent = async (eventKey: string, eventType: string) => {
      await appendAndEnqueueInboundMessage({
        message: createEventInboundMessage({
          event: {
            eventKey,
            eventType,
            identifier: "getsentry/junior#1563",
            namespace: "github",
            occurredAtMs: Date.now(),
            trustedSummary: eventType,
          },
          // Past the Event batch wait, so the Turn runs on this delivery.
          receivedAtMs: Date.now() - 60_000,
          subscription: { conversationId, id: "watch-follow-up-subscription" },
          text: eventType,
        }),
        queue,
        state,
      });
      await processNext();
    };

    await enqueueAgentDispatch(dispatch, { queue, state });
    await processNext();

    expect(slackApiOutbox.messages()).toHaveLength(1);
    expect(slackApiOutbox.messages()[0]?.params).toMatchObject({
      channel: destination.channelId,
      thread_ts: "1700000000.000200",
    });
    // The first reply binds the thread, so a person's reply before any later
    // Turn reaches this Conversation.
    await expect(
      getConversationStore().getConversationIdByProviderConversation({
        provider: "slack",
        providerConversationId: "1700000000.000200",
        providerDestinationId: destination.channelId,
        providerTenantId: destination.teamId,
      }),
    ).resolves.toBe(conversationId);

    // Watch Event Turns reply in the run's thread, or stay quiet.
    await watchEvent("watch-merged", "pull_request.merged");
    await watchEvent("watch-no-reply", "pull_request.comment.created");
    await watchEvent("watch-no-answer", "pull_request.checks.failed");
    expect(threadPosts()).toEqual(["Scheduled digest", "The change merged."]);
    expect(modelStream).toHaveBeenCalledTimes(6);

    // A Turn on a child's reply replies in the run's thread.
    const child = await createAgentInvocation({
      actor: { name: "automation-run", platform: "system" },
      destination,
      idempotencyKey: "watch-follow-up-child",
      input: "Check the release.",
      parentConversationId: conversationId,
      reasoningLevel: "medium",
    });
    await enqueueChildResultToParent({
      nowMs: Date.now() - 60_000,
      queue,
      result: {
        kind: "reply",
        reply: {
          text: "The release is green.",
          toolCallId: "call-child-reply",
        },
      },
      messageKey: "call-child-reply",
      sender: child,
      turnId: getAgentInvocationTurnId(child.invocationId),
      state,
    });
    await processNext();
    expect(threadPosts().at(-1)).toBe("The child agent finished.");

    // A person's reply in the run's thread runs in the run's Conversation and
    // gets its final response.
    await handleSlackWebhookAndFlush({
      request: slackWebhookRequest(
        slackEnvelope({
          text: `<@${SLACK_BOT_USER_ID}> is the digest current?`,
          threadTs: "1700000000.000200",
          ts: "1700000000.000900",
        }),
      ),
      services: { getSlackAdapter: () => adapter, queue, runtime, state },
    });
    await processNext();
    expect(threadPosts().at(-1)).toBe("The digest is up to date.");

    // A Watch outlives the dispatch record, so reportBlocked on a later Watch
    // Event Turn finds the Automation through its stored run.
    await recordAutomationExecution("sched_watch_follow_up", {
      conversationId,
      executionId: "sched_watch_follow_up:run",
    });
    await state.delete(getDispatchStorageKey(dispatch.id));
    await watchEvent("watch-blocked", "pull_request.closed");
    await expect(
      readScheduledAutomation(getDb(), "sched_watch_follow_up"),
    ).resolves.toMatchObject({
      status: "blocked",
      statusReason: "The digest repository was archived.",
    });
    expect(threadPosts()).toHaveLength(4);
  }, 30_000);

  it("sends successful work to each outcome destination in order", async () => {
    // A person's Conversation started in the second outcome's thread.
    const personThread = {
      provider: "slack",
      providerConversationId: "1700000000.000400",
      providerDestinationId: "C456",
      providerTenantId: destination.teamId,
    };
    const personConversationId = "slack:C456:1700000000.000400";
    await getConversationStore().claimProviderConversation({
      ...personThread,
      atMs: Date.now(),
      conversationId: personConversationId,
    });
    const dispatch = await createDispatch(
      "multiple-message-outcomes",
      undefined,
      undefined,
      undefined,
      "Send the result to both destinations.",
      [
        {
          action: "send_message",
          destination: { ...destination, channelId: "D123" },
        },
        {
          action: "send_message",
          destination: {
            ...destination,
            channelId: "C456",
            threadTs: "1700000000.000400",
          },
        },
      ],
    );
    const { queue, run, state } = await createConversationWorkHarness(
      createModelAgentRunner(createModelStream([sendMessage("Work complete")])),
    );
    queueSlackApiResponse("chat.postMessage", {
      body: chatPostMessageOk({ channel: "D123", ts: "1700000000.000401" }),
    });

    await enqueueAgentDispatch(dispatch, { queue, state });
    await processConversationQueueMessage(queue.takeMessage(), {
      queue,
      run,
      state,
    });

    expect(
      slackApiOutbox.messages().map((message) => message.params.channel),
    ).toEqual(["D123", "C456"]);
    // The run stores its reply, and the thread stays with the person's
    // Conversation.
    const stored = coerceThreadConversationState({});
    await hydrateConversationMessages({
      conversation: stored,
      conversationId: getDispatchConversationId(dispatch),
    });
    expect(stored.messages).toContainEqual(
      expect.objectContaining({ role: "assistant", text: "Work complete" }),
    );
    await expect(
      getConversationStore().getConversationIdByProviderConversation(
        personThread,
      ),
    ).resolves.toBe(personConversationId);
    // A post outside the run's destination stays unbound, so a reply in the
    // D123 thread starts its own Conversation.
    await expect(
      getConversationStore().getConversationIdByProviderConversation({
        provider: "slack",
        providerConversationId: "1700000000.000401",
        providerDestinationId: "D123",
        providerTenantId: destination.teamId,
      }),
    ).resolves.toBeUndefined();
  });

  it("posts nothing for a run without a reply or outcomes, also when it fails", async () => {
    const dispatch = await createDispatch(
      "no-outcomes",
      undefined,
      undefined,
      undefined,
      "Apply the requested maintenance.",
      [],
    );
    const lostDispatch = await createDispatch(
      "no-outcomes-lost-worker",
      undefined,
      undefined,
      undefined,
      "Apply the requested maintenance.",
      [],
    );
    const quietDispatch = await createDispatch("no-reply");
    const blockedDispatch = await createDispatch("blocked", undefined, {
      kind: "event_automation",
      automationId: "automation-1",
      automationRunId: "automation-run-1",
    });
    const unansweredDispatch = await createDispatch("no-answer");
    const modelStream = vi.fn(
      createModelStream([
        {
          type: "toolCall",
          name: "noReply",
          arguments: { note: "Maintenance complete" },
        },
        {
          type: "toolCall",
          name: "noReply",
          arguments: { note: "Nothing changed." },
        },
        {
          type: "toolCall",
          name: "reportBlocked",
          arguments: { missing: "The digest repository was archived." },
        },
        // A Turn without an answer gets one re-ask, then posts nothing.
        { type: "text", text: "Here is the digest." },
        { type: "text", text: "Here is the digest again." },
        { type: "toolCall", name: "systemTime", arguments: {} },
      ]),
    );
    const agentRunner = createModelAgentRunner(modelStream);
    const runAgent = vi.spyOn(agentRunner, "run");
    const { queue, run, state } =
      await createConversationWorkHarness(agentRunner);
    const processNext = async (softYieldAfterMs?: number) =>
      await processConversationQueueMessage(queue.takeMessage(), {
        queue,
        run,
        softYieldAfterMs,
        state,
      });

    await enqueueAgentDispatch(dispatch, { queue, state });
    await processNext();

    expect(slackApiOutbox.messages()).toEqual([]);
    await expect(getDispatchRecord(dispatch.id)).resolves.toMatchObject({
      status: "completed",
      outcomes: [],
    });
    expect(runAgent).toHaveBeenCalledOnce();
    expect(runAgent.mock.calls[0]?.[0]).not.toHaveProperty("delivery");

    for (const answered of [
      quietDispatch,
      blockedDispatch,
      unansweredDispatch,
    ]) {
      await enqueueAgentDispatch(answered, { queue, state });
      await processNext();
    }

    expect(slackApiOutbox.messages()).toEqual([]);
    expect(modelStream).toHaveBeenCalledTimes(5);
    await expect(getDispatchRecord(quietDispatch.id)).resolves.toMatchObject({
      status: "completed",
    });
    await expect(getDispatchRecord(blockedDispatch.id)).resolves.toMatchObject({
      errorMessage: "The digest repository was archived.",
      status: "blocked",
    });
    await expect(
      getDispatchRecord(unansweredDispatch.id),
    ).resolves.toMatchObject({
      errorMessage: "Automation run ended without an answer.",
      status: "failed",
    });

    // The second run pauses, and its resumed worker dies before it saves.
    // Recovery fails the run, and the failure still posts nothing.
    await enqueueAgentDispatch(lostDispatch, { queue, state });
    await processNext(0);
    const conversationId = getDispatchConversationId(lostDispatch);
    const turnId = getDispatchTurnId(lostDispatch.id);
    const paused = await getTurnRecord(conversationId, turnId);
    if (paused?.state !== "paused") throw new Error("expected paused turn");
    await saveTurnCheckpoint({
      conversationId,
      errorMessage: LOST_WORKER_RESUME_MESSAGE,
      lostWorkerResumeCount: 1,
      messages: paused.piMessages,
      mode: "paused",
      reason: "retry",
      sliceId: paused.sliceId,
      turnId,
    });
    await processNext();

    await expect(getTurnRecord(conversationId, turnId)).resolves.toMatchObject({
      state: "failed",
    });
    await expect(getDispatchRecord(lostDispatch.id)).resolves.toMatchObject({
      status: "failed",
    });
    expect(slackApiOutbox.messages()).toEqual([]);
  });

  it("projects a previously delivered reply without running the agent again", async () => {
    const dispatch = await createDispatch("delivered-replay");
    const conversationId = getDispatchConversationId(dispatch);
    const turnId = getDispatchTurnId(dispatch.id);
    const conversation = coerceThreadConversationState({});
    conversation.messages.push(
      {
        id: getDispatchInputMessageId(dispatch.id),
        role: "user",
        text: dispatch.input,
        createdAtMs: dispatch.createdAtMs,
        author: { isBot: true, userName: "scheduler" },
        meta: { replied: true },
      },
      {
        id: `${turnId}:assistant:1`,
        role: "assistant",
        text: "Already delivered digest",
        createdAtMs: dispatch.createdAtMs + 1,
        author: { isBot: true, userName: "junior" },
        meta: {
          replied: true,
          slackTs: "1700000000.000009",
        },
      },
    );
    await persistConversationMessages({ conversation, conversationId });
    const { queue, run, state } = await createConversationWorkHarness(
      neverRunAgentRunner(),
    );

    await enqueueAgentDispatch(dispatch, { queue, state });
    await processConversationQueueMessage(queue.takeMessage(), {
      queue,
      run,
      state,
    });

    expect(queue.hasQueuedMessages()).toBe(false);
    await expect(getDispatchRecord(dispatch.id)).resolves.toMatchObject({
      resultMessageTs: "1700000000.000009",
      status: "completed",
    });
  });
});
