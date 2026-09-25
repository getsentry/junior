/**
 * Drive scenario events through the real Slack runtime and conversation worker.
 */
import type { SlackAdapter } from "@chat-adapter/slack";
import { ThreadImpl } from "chat";
import { createSlackSource } from "@sentry/junior-plugin-api";
import { createConversationWork } from "@/chat/app/conversation-work";
import { getConversationStore, getDb } from "@/chat/db";
import type { AssistantLifecycleEvent } from "@/chat/providers/slack/runtime";
import { determineThreadMessageKind } from "@/chat/ingress/message-router";
import { buildSlackInboundMessage } from "@/chat/task-execution/slack-work";
import { appendAndEnqueueInboundMessage } from "@/chat/task-execution/store";
import type { AgentRunner } from "@/chat/runtime/agent-runner";
import { listIncompleteScheduledRuns } from "@/chat/scheduled-automations/runs";
import {
  readScheduledAutomation,
  saveScheduledAutomation,
} from "@/chat/scheduled-automations/tasks";
import type { ScheduledAutomation } from "@/chat/scheduled-automations/types";
import { runScheduledAutomationHeartbeat } from "@/chat/scheduled-automations/heartbeat";
import { getDispatchRecord } from "@/chat/agent-dispatch/store";
import { ingestEvent } from "@/chat/events/ingest";
import { createWatch } from "@/chat/events/store";
import { ingestEventAutomations } from "@/chat/event-automations/ingest";
import { createEventAutomation } from "@/chat/event-automations/store";
import type { EventAutomation } from "@/chat/event-automations/types";
import { FakeSlackAdapter } from "@junior-tests/fixtures/slack-harness";
import { type ConversationWorkQueueTestAdapter } from "@junior-tests/fixtures/conversation-work";
import { TEST_USER_ID } from "@junior-tests/fixtures/slack/factories/ids";
import { processConversationQueueMessage } from "@/chat/task-execution/vercel-callback";
import { normalizeGitHubEvents } from "@sentry/junior-github/testing";
import {
  type EvalEventThreadFixture,
  type EvalBaseEvent,
  type MentionEvent,
  type SubscribedMessageEvent,
  type SteerEvent,
  type AssistantThreadStartedEvent,
  type AssistantContextChangedEvent,
  type ScheduledAutomationDueEvent,
  type EventAutomationMatchedEvent,
  type EventFixture,
  type GitHubWebhookEvent,
  type EvalEvent,
  isSlackMessageEvent,
  type EvalScenario,
  type SteeringDelivery,
  type EvalThreadRecord,
  type QueueDelivery,
  type RuntimeObservations,
} from "./types";
import { type HarnessEnvironment } from "./environment";
import {
  EVAL_SLACK_TEAM_ID,
  buildRuntimeThreadId,
  createEvalDestination,
  recordPendingPosts,
  recordUserMessage,
  toSlackMessage,
  upsertThreadTranscriptMessage,
} from "./threads";
import { autoCompleteMcpOauth, autoCompleteOauth } from "./auth-fixtures";

/** Deliver scenario events through the Slack runtime and drain conversation work. */
export async function processEvents(args: {
  scenario: EvalScenario;
  env: HarnessEnvironment;
  agentRunner: AgentRunner;
  getSlackAdapter: () => FakeSlackAdapter;
  conversationWorkQueue: ConversationWorkQueueTestAdapter;
  conversationWork: ReturnType<typeof createConversationWork>;
  getThreadRecord: (
    fixture: EvalEventThreadFixture,
  ) => Promise<EvalThreadRecord>;
  observations: RuntimeObservations;
  readyQueueDeliveries: QueueDelivery[];
  steeringDelivery: SteeringDelivery;
  threadRecordsById: Map<string, EvalThreadRecord>;
  signal?: AbortSignal;
}): Promise<void> {
  const {
    scenario,
    env,
    agentRunner,
    getSlackAdapter,
    conversationWorkQueue,
    conversationWork,
    getThreadRecord,
    readyQueueDeliveries,
    steeringDelivery,
  } = args;
  const slackRuntime = conversationWork.runtime;

  const consumedOauthStates = new Set<string>();
  const consumedMcpOauthStates = new Set<string>();

  const maybeAutoCompleteAuth = async (): Promise<void> => {
    for (const provider of env.autoCompleteMcpOauthProviders) {
      await autoCompleteMcpOauth({
        agentRunner,
        completions: args.observations.authorizationCompletions,
        provider,
        consumedStates: consumedMcpOauthStates,
      });
    }
    for (const provider of env.autoCompleteOauthProviders) {
      await autoCompleteOauth({
        agentRunner,
        completions: args.observations.authorizationCompletions,
        provider,
        consumedStates: consumedOauthStates,
      });
    }
  };

  const processNextDelivery = async (): Promise<boolean> => {
    const current = readyQueueDeliveries.shift();
    if (!current) {
      return false;
    }
    const destination = createEvalDestination(current.thread);
    if (current.kind === "new_mention") {
      await slackRuntime.handleNewMention(current.thread, current.message, {
        destination,
      });
    } else {
      await slackRuntime.handleSubscribedMessage(
        current.thread,
        current.message,
        {
          destination,
        },
      );
    }
    return true;
  };

  const drainQueuedConversationWork = async (): Promise<void> => {
    let processed = 0;
    while (conversationWorkQueue.hasQueuedMessages()) {
      processed += 1;
      if (processed > 10) {
        throw new Error("Eval conversation work queue did not drain");
      }
      const result = await processConversationQueueMessage(
        await conversationWorkQueue.takeReadyMessage(args.signal),
        {
          conversationStore: conversationWork.conversationStore,
          queue: conversationWorkQueue,
          run: conversationWork.run,
          state: env.stateAdapter,
        },
      );
      if (result.status === "failed") {
        throw new Error("Eval conversation worker failed");
      }
      await maybeAutoCompleteAuth();
    }
  };

  const appendMailboxMessages = async (
    events: Array<MentionEvent | SubscribedMessageEvent>,
  ): Promise<void> => {
    for (const [index, event] of events.entries()) {
      recordPendingPosts(args.threadRecordsById, args.observations);
      recordUserMessage(args.observations, event);
      const { thread, transcript } = await getThreadRecord(event.thread);
      const route =
        (event.message.is_mention ?? event.type === "new_mention")
          ? ("mention" as const)
          : ("subscribed" as const);
      const message = toSlackMessage(event, thread.id, Date.now() + index);
      upsertThreadTranscriptMessage(transcript, message);
      const ingressThread = new ThreadImpl({
        adapter: getSlackAdapter() as unknown as SlackAdapter,
        stateAdapter: env.stateAdapter,
        id: thread.id,
        channelId: thread.channelId,
        currentMessage: message,
        initialMessage: message,
        isDM: thread.id.startsWith("slack:D"),
        isSubscribedContext: route === "subscribed",
      });
      await appendAndEnqueueInboundMessage({
        message: buildSlackInboundMessage({
          conversationId: thread.id,
          installation: { teamId: EVAL_SLACK_TEAM_ID },
          message,
          receivedAtMs: Date.now(),
          route,
          thread: ingressThread,
        }),
        queue: conversationWorkQueue,
        state: env.stateAdapter,
      });
    }
  };

  const enqueueEvent = async (
    event: MentionEvent | SubscribedMessageEvent,
  ): Promise<void> => {
    recordPendingPosts(args.threadRecordsById, args.observations);
    recordUserMessage(args.observations, event);
    const { thread, transcript } = await getThreadRecord(event.thread);
    const message = toSlackMessage(event, thread.id);
    upsertThreadTranscriptMessage(transcript, message);
    const kind = determineThreadMessageKind({
      isDirectMessage: thread.id.startsWith("slack:D"),
      isMention: event.message.is_mention ?? event.type === "new_mention",
      isSubscribed: event.type === "subscribed_message",
    });
    if (!kind) {
      return;
    }
    readyQueueDeliveries.push({ kind, message, thread });
  };

  const runLifecycleEvent = async (
    event: AssistantThreadStartedEvent | AssistantContextChangedEvent,
  ): Promise<void> => {
    const lifecycleEvent: AssistantLifecycleEvent = {
      threadId: event.thread.id,
      channelId: event.thread.channel_id ?? "CEVAL",
      threadTs: event.thread.thread_ts ?? "0",
      userId: event.user_id ?? "U-eval",
    };
    if (event.type === "assistant_thread_started") {
      await slackRuntime.handleAssistantThreadStarted(lifecycleEvent);
      return;
    }
    await slackRuntime.handleAssistantContextChanged(lifecycleEvent);
  };

  const runScheduledAutomationDue = async (
    event: ScheduledAutomationDueEvent,
  ): Promise<void> => {
    const { thread } = await getThreadRecord(event.thread);
    const nowMs = event.now_ms ?? Date.now();
    const scheduleKind = event.schedule_kind ?? "one_off";
    const taskId = `eval_schedule_${thread.channelId}_${nowMs}`;
    const destination = createEvalDestination(
      thread,
    ) as ScheduledAutomation["destination"];
    const task: ScheduledAutomation = {
      id: taskId,
      conversationAccess: { audience: "channel", visibility: "public" },
      createdAtMs: nowMs - 60_000,
      createdBy: { slackUserId: TEST_USER_ID, userName: "testuser" },
      creatorIdentityId: `eval:slack:${TEST_USER_ID}`,
      credentialMode: event.credential_mode ?? "system",
      destination,
      outcomes: [{ action: "send_message", destination }],
      nextRunAtMs: nowMs,
      schedule: {
        description:
          event.schedule ??
          (scheduleKind === "recurring" ? "Weekly at noon" : "Once now"),
        kind: scheduleKind,
        timezone: event.timezone ?? "UTC",
        ...(scheduleKind === "recurring"
          ? {
              recurrence: {
                frequency: event.recurrence ?? "weekly",
                interval: 1,
                startDate: new Date(nowMs).toISOString().slice(0, 10),
                time: { hour: 12, minute: 0 },
              },
            }
          : {}),
      },
      status: "active",
      task: { text: event.task_text },
      updatedAtMs: nowMs - 60_000,
    };
    const db = getDb();
    await saveScheduledAutomation(db, task);

    await runScheduledAutomationHeartbeat({
      conversationWorkQueue,
      nowMs,
    });

    const runs = (await listIncompleteScheduledRuns(db)).filter(
      (run) => run.taskId === taskId,
    );
    const dispatchedRuns = runs.filter((run) => run.dispatchId);
    if (dispatchedRuns.length === 0) {
      const savedTask = await readScheduledAutomation(db, taskId);
      throw new Error(
        `Scheduled eval task did not create a dispatch: ${JSON.stringify({ runs, savedTask })}`,
      );
    }
    for (const run of dispatchedRuns) {
      const dispatch = await getDispatchRecord(run.dispatchId!);
      if (!dispatch) {
        throw new Error("Scheduled eval dispatch record was not found.");
      }
      if (event.credential_mode === "creator") {
        const subject = dispatch.credentialSubject;
        if (
          !subject ||
          subject.type !== "user" ||
          subject.userId !== TEST_USER_ID ||
          subject.allowedWhen !== "scheduled-automation" ||
          subject.taskId !== taskId ||
          subject.binding.type !== "scheduled-automation" ||
          subject.binding.plugin !== "scheduler" ||
          subject.binding.taskId !== taskId
        ) {
          throw new Error(
            "Creator-bound scheduled eval dispatch did not use the task creator.",
          );
        }
      } else if (dispatch.credentialSubject) {
        throw new Error(
          "System scheduled eval dispatch unexpectedly used a user credential subject.",
        );
      }
    }
    await drainQueuedConversationWork();
  };

  const runGitHubWebhook = async (event: GitHubWebhookEvent): Promise<void> => {
    const { thread } = await getThreadRecord(event.thread);
    const nowMs = Date.now();
    await createWatch(
      {
        conversationId: thread.id,
        events: event.subscription.events,
        expiresAtMs: nowMs + 14 * 24 * 60 * 60 * 1000,
        intent: event.subscription.intent,
        label: event.subscription.label,
        namespace: "github",
        identifier: event.subscription.identifier,
        resourceType: event.subscription.resource_type,
      },
      { nowMs, state: env.stateAdapter },
    );
    const normalizedEvents = normalizeGitHubEvents({
      body: event.body,
      deliveryId: event.delivery_id,
      eventName: event.event_name,
    });
    for (const normalizedEvent of normalizedEvents) {
      await ingestEvent(
        { ...normalizedEvent, namespace: "github" },
        {
          nowMs,
          queue: conversationWorkQueue,
          state: env.stateAdapter,
        },
      );
    }
    await drainQueuedConversationWork();
  };

  const runEvent = async (event: EventFixture): Promise<void> => {
    const { thread } = await getThreadRecord(event.thread);
    const nowMs = Date.now();
    const destination = createEvalDestination(thread);
    await getConversationStore().recordActivity({
      conversationId: thread.id,
      destination,
      nowMs,
      sessionSource: createSlackSource({
        channelId: destination.channelId,
        teamId: destination.teamId,
        ...(thread.threadTs ? { threadTs: thread.threadTs } : undefined),
        visibility: "public",
      }),
      source: "slack",
      visibility: "public",
    });
    await createWatch(
      {
        conversationId: thread.id,
        events: [event.event_type],
        expiresAtMs: nowMs + 14 * 24 * 60 * 60 * 1000,
        intent: event.intent,
        label: event.label,
        namespace: event.namespace,
        identifier: event.identifier,
        resourceType: event.resource_type,
      },
      { nowMs, state: env.stateAdapter },
    );
    const result = await ingestEvent(
      {
        data: event.data,
        eventKey: event.event_key,
        eventType: event.event_type,
        identifier: event.identifier,
        namespace: event.namespace,
        occurredAtMs: nowMs,
        trustedSummary: event.trusted_summary,
        untrustedText: event.untrusted_text,
      },
      {
        nowMs,
        queue: conversationWorkQueue,
        state: env.stateAdapter,
      },
    );
    if (result.enqueued !== 1) {
      throw new Error(
        `Event eval expected one queued input, got ${result.enqueued}`,
      );
    }
    await drainQueuedConversationWork();
  };

  const runEventAutomationMatched = async (
    event: EventAutomationMatchedEvent,
  ): Promise<void> => {
    const { thread } = await getThreadRecord(event.thread);
    const nowMs = Date.now();
    const taskId = `eval_event_automation_${thread.channelId}_${nowMs}`;
    const destination = createEvalDestination(thread);
    const task: EventAutomation = {
      id: taskId,
      createdAtMs: nowMs - 60_000,
      createdBy: { slackUserId: TEST_USER_ID, userName: "testuser" },
      credentialMode: "system",
      destination,
      destinationVisibility: "public",
      outcomes: [{ action: "send_message", destination }],
      task: { text: event.task_text },
      trigger: {
        events: [event.event_type],
        label: event.label,
        namespace: event.namespace,
        identifier: event.identifier,
        resourceType: event.resource_type,
      },
    };
    await createEventAutomation(getDb(), task);
    const result = await ingestEventAutomations(
      {
        eventKey: event.event_key,
        eventType: event.event_type,
        occurredAtMs: nowMs,
        namespace: event.namespace,
        identifier: event.identifier,
        trustedSummary: event.trusted_summary,
        ...(event.untrusted_text
          ? { untrustedText: event.untrusted_text }
          : {}),
      },
      {
        nowMs,
        queue: conversationWorkQueue,
        teamId: task.destination.teamId,
      },
    );
    if (result.dispatched !== 1) {
      throw new Error(
        `Event automation eval expected one dispatch, got ${result.dispatched}`,
      );
    }
    await drainQueuedConversationWork();
  };

  const processSettledEvent = async (event: EvalEvent): Promise<void> => {
    if (event.type === "new_mention" || event.type === "subscribed_message") {
      await enqueueEvent(event);
    } else if (event.type === "scheduled_automation_due") {
      await runScheduledAutomationDue(event);
    } else if (event.type === "event_automation_matched") {
      await runEventAutomationMatched(event);
    } else if (event.type === "event") {
      await runEvent(event);
    } else if (event.type === "github_webhook") {
      await runGitHubWebhook(event);
    } else {
      await runLifecycleEvent(event);
    }
    await maybeAutoCompleteAuth();
    if (await processNextDelivery()) {
      await maybeAutoCompleteAuth();
      await drainQueuedConversationWork();
    }
  };

  const stageSteering = (
    preceding: readonly EvalBaseEvent[],
    steering: SteerEvent,
  ): void => {
    const conversationIds = new Set(
      [...preceding, ...steering.events].map((event) =>
        buildRuntimeThreadId(event.thread),
      ),
    );
    if (conversationIds.size !== 1) {
      throw new Error(
        "steer() messages must target the preceding Conversation",
      );
    }
    steeringDelivery.deliver = async () => {
      await appendMailboxMessages(steering.events);
    };
  };

  const processMessageGroup = async (
    messages: Array<MentionEvent | SubscribedMessageEvent>,
    steering?: SteerEvent,
  ): Promise<void> => {
    if (steering) {
      stageSteering(messages, steering);
    }
    await appendMailboxMessages(messages);
    await maybeAutoCompleteAuth();
    await drainQueuedConversationWork();
    if (steeringDelivery.deliver) {
      steeringDelivery.deliver = undefined;
      throw new Error(
        "steer() requires the preceding message group to start an agent run",
      );
    }
  };

  const processEvent = async (
    event: EventFixture,
    steering?: SteerEvent,
  ): Promise<void> => {
    if (steering) {
      stageSteering([event], steering);
    }
    await processSettledEvent(event);
    if (steeringDelivery.deliver) {
      steeringDelivery.deliver = undefined;
      throw new Error(
        "steer() requires the preceding Event to start an agent run",
      );
    }
  };

  const remainingEvents = scenario.events ?? [];
  let nextIndex = 0;
  const initialSteering =
    remainingEvents[0]?.type === "steer" ? remainingEvents[0] : undefined;
  if (initialSteering) {
    nextIndex = 1;
  }
  if (initialSteering && scenario.initialEvents.length === 0) {
    throw new Error("steer() requires a preceding event");
  }

  const initialMessages = Array.from(scenario.initialEvents).filter(
    isSlackMessageEvent,
  );

  if (
    initialMessages.length > 0 &&
    initialMessages.length === scenario.initialEvents.length
  ) {
    await processMessageGroup(initialMessages, initialSteering);
  } else {
    if (scenario.initialEvents.length > 1) {
      throw new Error(
        "Multiple initialEvents and steer() require Slack message events",
      );
    }
    const initialEvent = scenario.initialEvents[0];
    if (initialEvent) {
      if (initialSteering) {
        if (initialEvent.type !== "event") {
          throw new Error("steer() must follow a Slack message or Event");
        }
        await processEvent(initialEvent, initialSteering);
      } else {
        await processSettledEvent(initialEvent);
      }
    }
  }

  while (nextIndex < remainingEvents.length) {
    const event = remainingEvents[nextIndex];
    if (!event) {
      break;
    }
    if (event.type === "steer") {
      throw new Error("steer() requires a preceding event");
    }
    const nextEvent = remainingEvents[nextIndex + 1];
    const steering = nextEvent?.type === "steer" ? nextEvent : undefined;
    if (steering) {
      if (event.type === "event") {
        await processEvent(event, steering);
      } else if (
        event.type === "new_mention" ||
        event.type === "subscribed_message"
      ) {
        await processMessageGroup([event], steering);
      } else {
        throw new Error("steer() must follow a Slack message or Event");
      }
      nextIndex += 2;
      continue;
    }
    await processSettledEvent(event);
    nextIndex += 1;
  }

  while (readyQueueDeliveries.length > 0) {
    const processed = await processNextDelivery();
    if (!processed) {
      break;
    }
    await maybeAutoCompleteAuth();
    await drainQueuedConversationWork();
  }
}
