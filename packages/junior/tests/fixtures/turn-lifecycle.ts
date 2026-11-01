/**
 * The work owners and lifecycle signals of the Turn lifecycle table in
 * `integration/durable-queue.test.ts`. Each owner starts its own work through
 * production entry points. Each signal sets the model output and says what the
 * owner shows after the Turn ends.
 */
import { expect } from "vitest";
import { createSlackSource } from "@sentry/junior-plugin-api";
import { enqueueAgentDispatch } from "@/chat/agent-dispatch/work";
import {
  getDispatchConversationId,
  getDispatchRecord,
} from "@/chat/agent-dispatch/store";
import {
  getAgentInvocation,
  getLatestAgentInvocationForConversation,
} from "@/chat/agent-invocations/store";
import { createAndEnqueueAgentInvocation } from "@/chat/agent-invocations/work";
import { createAndEnqueueConversation } from "@/chat/conversations/web-input";
import { getConversationEventStore, getConversationStore } from "@/chat/db";
import { getEventCatalog } from "@/chat/events/runtime-catalog";
import { createEventInboundMessage } from "@/chat/events/notification";
import { runTimerWatchHeartbeat } from "@/chat/events/timers";
import {
  appendAndEnqueueInboundMessage,
  CONVERSATION_WORK_MAX_RETRIES,
} from "@/chat/task-execution/store";
import { createEventTools } from "@/chat/tools/events";
import { createAgentDispatchTestRecord } from "./agent-dispatch";
import {
  invocationInput,
  loadSubagentEvents,
  parentConversationId,
  prepareParentConversation,
} from "./agent-invocations";
import { webTestActor } from "./conversation";
import {
  CONVERSATION_ID,
  SLACK_BOT_USER_ID,
  SLACK_DESTINATION,
  type createConversationWorkHarness,
  handleSlackWebhookAndFlush,
  slackEnvelope,
  slackWebhookRequest,
} from "./conversation-work";
import { context, execute } from "./event-automations";
import type { FixedModelOutput } from "./model-stream";
import { slackApiOutbox } from "./slack-api-outbox";

type Harness = Awaited<ReturnType<typeof createConversationWorkHarness>>;

/** Texts of the Slack messages that the work posted. */
export function slackReplies(): string[] {
  return slackApiOutbox
    .messages()
    .map((call) => call.params.text)
    .filter((text): text is string => typeof text === "string");
}

/** Where an owner sends what its Turn says. */
type Delivery = "junior" | "slack" | "parent";

export interface Owner {
  name: string;
  delivery: Delivery;
  /** Model output that ends a Turn of this owner with `text`. */
  reply?(text: string): FixedModelOutput;
  /** Model output that the owner uses before its Turn under test. */
  setupOutputs?: FixedModelOutput[];
  /** Create the Conversation and queue new input. Return its id. */
  start(harness: Harness): Promise<string>;
  /** Run the Turns that must finish before the input under test. */
  setup?(args: {
    conversationId: string;
    harness: Harness;
    process: (softYieldAfterMs?: number) => Promise<unknown>;
  }): Promise<void>;
  /** Read what the owner shows after the Turn ends. */
  read(conversationId: string): Promise<Record<string, unknown>>;
  /**
   * Wake results when every attempt throws, where the owner still runs its
   * own retry lifecycle instead of the shared one.
   */
  failedWakes?: string[];
  /** Wake results when every resume attempt throws. */
  failedResumeWakes?: string[];
  /** True when a failed Turn posts no error reply, by owner policy. */
  quietFailure?: boolean;
  /** Signals that this owner does not handle through the shared lifecycle. */
  unsupported?: string[];
}

export const clock = { nowMs: 1_800_000_000_000 };
export const closers: Array<() => Promise<void>> = [];

/** Read how the last Turn of a Conversation ended. */
export async function lastTurnEnd(conversationId: string): Promise<string> {
  const last = (await getConversationEventStore().loadHistory(conversationId))
    .map((event) => event.data)
    .filter(
      (data) => data.type === "turn_completed" || data.type === "turn_failed",
    )
    .at(-1);
  if (!last) return "running";
  if (last.type === "turn_failed") return "failed";
  return last.outcome === "cancelled" ? "stopped" : "completed";
}

async function assistantMessages(conversationId: string): Promise<string[]> {
  return (await getConversationEventStore().loadHistory(conversationId))
    .map((event) => event.data)
    .flatMap((data) =>
      data.type === "message" && data.role === "assistant" ? [data.text] : [],
    );
}

/** Read the latest agent invocation of a child and its report to the parent. */
async function readChild(conversationId: string) {
  const latest = await getLatestAgentInvocationForConversation(conversationId);
  const invocation = latest && (await getAgentInvocation(latest.invocationId));
  const ended = (await loadSubagentEvents(parentConversationId)).filter(
    (event) =>
      event.type === "subagent_ended" &&
      event.subagentInvocationId === invocation?.invocationId,
  );
  return {
    invocation: invocation?.status,
    parentMailbox:
      invocation && "parentMailboxStatus" in invocation
        ? invocation.parentMailboxStatus
        : undefined,
    reportsToParent: ended.length,
  };
}

async function spawnChild(harness: Harness, idempotencyKey: string) {
  const { conversationStore, fixture } = await prepareParentConversation();
  closers.push(async () => await fixture.close());
  const created = await createAndEnqueueAgentInvocation(
    { ...invocationInput, idempotencyKey },
    { conversationStore, queue: harness.queue, state: harness.state },
  );
  return created.childConversationId;
}

export const owners: Owner[] = [
  {
    name: "root web",
    delivery: "junior",
    start: async (harness) =>
      (
        await createAndEnqueueConversation(
          {
            actor: webTestActor,
            idempotencyKey: "lifecycle-web",
            message: "Check the deploy.",
          },
          {
            conversationStore: getConversationStore(),
            queue: harness.queue,
            state: harness.state,
          },
        )
      ).conversationId,
    read: async (conversationId) => ({
      replies: await assistantMessages(conversationId),
    }),
  },
  {
    name: "root event with a Location",
    delivery: "slack",
    start: async (harness) => {
      const conversationId = "agent-dispatch:lifecycle-watch";
      await getConversationStore().recordActivity({
        conversationId,
        destination: SLACK_DESTINATION,
        nowMs: 1_000,
        sessionSource: createSlackSource({
          channelId: SLACK_DESTINATION.channelId,
          teamId: SLACK_DESTINATION.teamId,
          visibility: "public",
        }),
        source: "event",
        visibility: "public",
      });
      await appendAndEnqueueInboundMessage({
        message: createEventInboundMessage({
          event: {
            eventKey: "lifecycle-checks-failed",
            eventType: "pull_request.checks.failed",
            identifier: "getsentry/junior#1563",
            namespace: "github",
            occurredAtMs: 1_100,
            trustedSummary: "The subscribed check failed.",
          },
          receivedAtMs: 1_100,
          subscription: { conversationId, id: "lifecycle-subscription" },
          text: "The subscribed check failed.",
        }),
        queue: harness.queue,
        state: harness.state,
      });
      return conversationId;
    },
    read: async () => ({ replies: slackReplies() }),
  },
  {
    name: "root Slack",
    delivery: "slack",
    // Slack mailbox work requeues its message after a failed attempt and
    // dead-letters it on the last attempt.
    failedWakes: [
      ...Array.from(
        { length: CONVERSATION_WORK_MAX_RETRIES - 1 },
        () => "pending_requeued",
      ),
      "failed",
    ],
    // The Slack resume runner fails the Turn on the first error.
    failedResumeWakes: ["completed"],
    start: async (harness) => {
      const response = await handleSlackWebhookAndFlush({
        request: slackWebhookRequest(
          slackEnvelope({ text: `<@${SLACK_BOT_USER_ID}> check the deploy` }),
        ),
        services: {
          getSlackAdapter: () => harness.adapter,
          queue: harness.queue,
          runtime: harness.runtime,
          state: harness.state,
        },
      });
      expect(response.status).toBe(200);
      return CONVERSATION_ID;
    },
    read: async () => ({ replies: slackReplies() }),
  },
  {
    name: "dispatch",
    delivery: "slack",
    // An Automation run posts only a declared message. Its failure shows on
    // the Automation.
    quietFailure: true,
    // Dispatch work runs its own lifecycle. A stop fails its Turn, and a
    // failed last attempt leaves its Turn open.
    unsupported: ["stop mid-Turn", "every attempt throws"],
    // A dispatch resumes through the Slack resume runner.
    failedResumeWakes: ["completed"],
    // A dispatch declares its result with a tool call.
    reply: (message) => ({
      type: "toolCall",
      name: "finishAutomationRun",
      arguments: { result: "send_message", message },
    }),
    start: async (harness) => {
      const dispatch = await createAgentDispatchTestRecord("lifecycle");
      await enqueueAgentDispatch(dispatch, {
        queue: harness.queue,
        state: harness.state,
      });
      return getDispatchConversationId(dispatch);
    },
    read: async (conversationId) => ({
      dispatch: (
        await getDispatchRecord(conversationId.replace("agent-dispatch:", ""))
      )?.status,
      replies: slackReplies(),
    }),
  },
  {
    name: "child from a parent task",
    delivery: "parent",
    start: async (harness) => await spawnChild(harness, "lifecycle-task"),
    read: readChild,
  },
  {
    name: "child from a watch event",
    delivery: "parent",
    setupOutputs: [{ type: "text", text: "Watching." }],
    start: async (harness) => await spawnChild(harness, "lifecycle-watch"),
    setup: async ({ conversationId, harness, process }) => {
      // Finish the parent task, then set a timer on the child. The timer
      // event waits for its burst window, then starts a new agent
      // invocation with an event Source.
      await expect(process()).resolves.toMatchObject({ status: "completed" });
      await execute(
        createEventTools({ ...context(), conversationId }, getEventCatalog())
          .watchTimer!,
        { afterMs: 60_000, intent: "Check the deploy." },
        "lifecycle-timer",
      );
      clock.nowMs += 120_000;
      await runTimerWatchHeartbeat({
        nowMs: clock.nowMs,
        queue: harness.queue,
      });
      await expect(process()).resolves.toMatchObject({
        status: "pending_requeued",
      });
      clock.nowMs += 120_000;
      await expect(process(0)).resolves.toMatchObject({
        status: "pending_requeued",
      });
    },
    read: readChild,
  },
];

interface Signal {
  name: string;
  outputs(args: {
    reply: (text: string) => FixedModelOutput;
    stop: () => void;
  }): FixedModelOutput[];
  /** Make every agent run throw from this wake on. */
  failFromWake?: number;
  /** Pause the first wake at its first safe boundary. */
  yieldFirst?: boolean;
  /** What the owner shows after the Turn ends. */
  expected(owner: Owner): {
    wakes: string[];
    turn: string;
    shown: Record<string, unknown>;
  };
}

const REPLY = "Deploy checked.";
const ERROR_REPLY = expect.stringMatching(/^I ran into an internal error/);

/** What a finished Turn shows on its owner. */
function finished(
  owner: Owner,
  text: unknown,
  end: "completed" | "failed" | "stopped",
) {
  if (owner.delivery === "parent") {
    // A child has no Delivery. It reports its end to the parent once.
    return {
      invocation: end,
      parentMailbox: "appended",
      reportsToParent: 1,
    };
  }
  return {
    // A dispatch has no stopped status. A stop fails it.
    ...(owner.name === "dispatch"
      ? { dispatch: end === "completed" ? "completed" : "failed" }
      : undefined),
    replies: text ? [text] : [],
  };
}

export const signals: Signal[] = [
  {
    name: "new input completes",
    outputs: ({ reply }) => [reply(REPLY)],
    expected: (owner) => ({
      wakes: ["completed"],
      turn: "completed",
      shown: finished(owner, REPLY, "completed"),
    }),
  },
  {
    name: "yield, then an empty wake resumes",
    outputs: ({ reply }) => [
      { type: "toolCall", name: "systemTime", arguments: {} },
      reply(REPLY),
    ],
    yieldFirst: true,
    expected: (owner) => ({
      wakes: ["yielded", "completed"],
      turn: "completed",
      shown: finished(owner, REPLY, "completed"),
    }),
  },
  {
    name: "stop mid-Turn",
    outputs: ({ stop }) => [
      {
        type: "text",
        text: "Never sent.",
        onRequest: stop,
        waitFor: "abort",
        // An owner that ignores the stop finishes and fails this row.
        abortTimeoutMs: 5_000,
      },
    ],
    expected: (owner) => ({
      // The stop request also wakes the Conversation. That wake finds no work.
      wakes: ["completed", "no_work"],
      turn: "stopped",
      shown: finished(owner, undefined, "stopped"),
    }),
  },
  {
    name: "every attempt throws",
    outputs: () => [],
    failFromWake: 0,
    expected: (owner) => ({
      wakes: owner.failedWakes ?? [
        ...Array.from(
          { length: CONVERSATION_WORK_MAX_RETRIES - 1 },
          () => "failed",
        ),
        "completed",
      ],
      turn: "failed",
      // Where a person reads the Turn, the last attempt posts an error reply.
      shown: finished(
        owner,
        owner.delivery === "junior" || owner.quietFailure
          ? undefined
          : ERROR_REPLY,
        "failed",
      ),
    }),
  },
  {
    name: "every resume attempt throws",
    outputs: () => [{ type: "toolCall", name: "systemTime", arguments: {} }],
    yieldFirst: true,
    failFromWake: 1,
    expected: (owner) => ({
      wakes: [
        "yielded",
        ...(owner.failedResumeWakes ?? [
          ...Array.from(
            { length: CONVERSATION_WORK_MAX_RETRIES - 1 },
            () => "failed",
          ),
          "completed",
        ]),
      ],
      turn: "failed",
      shown: finished(
        owner,
        owner.delivery === "junior" || owner.quietFailure
          ? undefined
          : ERROR_REPLY,
        "failed",
      ),
    }),
  },
];
