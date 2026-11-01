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
  createAgentInvocation,
  getAgentInvocation,
  getAgentInvocationTurnId,
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
import { getTurnRecord } from "@/chat/task-execution/checkpoint";
import { createEventTools } from "@/chat/tools/events";
import { TurnToolCallLimitExceededError } from "@/chat/services/turn-limit";
import { createAgentDispatchTestRecord } from "./agent-dispatch";
import {
  invocationInput,
  loadSubagentEvents,
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
import type { AgentRunOutcome } from "@/chat/runtime/agent-run-outcome";
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
  /**
   * Rows where the Slack runner ends the Turn another way. It does not use
   * the shared lifecycle yet. Each value replaces part of the expected
   * outcome of the row with that name.
   */
  slackRunnerGaps?: Record<string, Partial<Expected>>;
}

/** What one row expects after the Turn ends. */
export interface Expected {
  wakes: string[];
  turn: string;
  shown: Record<string, unknown>;
}

export const clock = { nowMs: 1_800_000_000_000 };
export const closers: Array<() => Promise<void>> = [];

/**
 * Read how the last Turn of a Conversation ended. A Turn end without its
 * start says so.
 */
export async function lastTurnEnd(conversationId: string): Promise<string> {
  const events = (
    await getConversationEventStore().loadHistory(conversationId)
  ).map((event) => event.data);
  const last = events
    .filter(
      (data) => data.type === "turn_completed" || data.type === "turn_failed",
    )
    .at(-1);
  if (!last) {
    return events.some((data) => data.type === "turn_started")
      ? "running"
      : "not started";
  }
  const end =
    last.type === "turn_failed"
      ? "failed"
      : last.outcome === "cancelled"
        ? "stopped"
        : last.outcome === "blocked"
          ? "blocked"
          : "completed";
  const started = events.some(
    (data) => data.type === "turn_started" && data.turnId === last.turnId,
  );
  return started ? end : `${end} without a start`;
}

async function assistantMessages(conversationId: string): Promise<string[]> {
  return (await getConversationEventStore().loadHistory(conversationId))
    .map((event) => event.data)
    .flatMap((data) =>
      data.type === "message" && data.role === "assistant" ? [data.text] : [],
    );
}

/**
 * Read the latest agent invocation of a child, its report to the parent, and
 * whether its Turn record can still resume.
 */
async function readChild(conversationId: string) {
  const latest = await getLatestAgentInvocationForConversation(conversationId);
  const invocation = latest && (await getAgentInvocation(latest.invocationId));
  if (!invocation) return {};
  const ended = (
    await loadSubagentEvents(invocation.parentConversationId)
  ).filter(
    (event) =>
      event.type === "subagent_ended" &&
      event.subagentInvocationId === invocation.invocationId,
  );
  const turn = await getTurnRecord(
    conversationId,
    getAgentInvocationTurnId(invocation.invocationId),
  );
  return {
    invocation: invocation.status,
    parentMailbox:
      "parentMailboxStatus" in invocation
        ? invocation.parentMailboxStatus
        : undefined,
    reportsToParent: ended.length,
    turnRecordOpen: turn?.state === "running" || turn?.state === "paused",
  };
}

/** Spawn a child of the root, or of another child at `depth` 2. */
async function spawnChild(
  harness: Harness,
  idempotencyKey: string,
  depth: 1 | 2 = 1,
) {
  const { conversationStore, fixture } = await prepareParentConversation();
  closers.push(async () => await fixture.close());
  const services = {
    conversationStore,
    queue: harness.queue,
    state: harness.state,
  };
  const created = await createAndEnqueueAgentInvocation(
    { ...invocationInput, idempotencyKey },
    services,
  );
  if (depth === 1) {
    return created.childConversationId;
  }
  // The child stays open, so its own child can start.
  return (
    await createAndEnqueueAgentInvocation(
      {
        ...invocationInput,
        idempotencyKey: `${idempotencyKey}-nested`,
        parentConversationId: created.childConversationId,
      },
      services,
    )
  ).childConversationId;
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
    slackRunnerGaps: {
      // A stop after the Run drops the saved result.
      "stop after the Run keeps the result": { turn: "stopped" },
      // An execution limit retries, then posts its own reply.
      "an execution limit fails at once": {
        wakes: [
          ...Array.from(
            { length: CONVERSATION_WORK_MAX_RETRIES - 1 },
            () => "pending_requeued",
          ),
          "failed",
        ],
        shown: { replies: [expect.stringMatching(/execution limit/)] },
      },
      // The failure has no Turn start when the start write failed.
      "a setup error fails on the last attempt": {
        turn: "failed without a start",
      },
    },
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
    // A dispatch resumes through the Slack resume runner.
    failedResumeWakes: ["completed"],
    // A dispatch runs its Turn through the Slack runner.
    slackRunnerGaps: {
      // A stop before the Run ends the dispatch without a Turn.
      "stop before the Run": { turn: "not started" },
      // A stop after the Run drops the saved result.
      "stop after the Run keeps the result": {
        turn: "stopped",
        shown: { dispatch: "failed", replies: [] },
      },
      "a setup error fails on the last attempt": {
        turn: "failed without a start",
      },
    },
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
    name: "child at depth 2",
    delivery: "parent",
    start: async (harness) => await spawnChild(harness, "lifecycle-nested", 2),
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
  /** Owners of this row. Omit it for every owner. */
  appliesTo?(owner: Owner): boolean;
  outputs(args: {
    reply: (text: string) => FixedModelOutput;
    stop: () => void;
  }): FixedModelOutput[];
  /** Run after the owner setup, before the first wake. */
  before?(args: { conversationId: string; stop: () => void }): Promise<void>;
  /** Make every agent run throw from this wake on. */
  failFromWake?: number;
  /** The error that each agent run throws. */
  failure?(): Error;
  /** End every agent run with this outcome instead of the model output. */
  outcome?: AgentRunOutcome;
  /** Request a stop after each Run returns, and wait until the Turn sees it. */
  stopAfterRun?: boolean;
  /**
   * Make a Turn lifecycle write fail: `complete` once, or `start` on every
   * attempt.
   */
  lifecycleFailure?: "complete" | "start";
  /** Pause the first wake at its first safe boundary. */
  yieldFirst?: boolean;
  /** What the owner shows after the Turn ends. */
  expected(owner: Owner): Expected;
}

const REPLY = "Deploy checked.";
const ERROR_REPLY = expect.stringMatching(/^I ran into an internal error/);
const isChild = (owner: Owner) => owner.delivery === "parent";

/** What a failed Turn shows on its owner. */
function failed(owner: Owner) {
  // Where a person reads the Turn, the last attempt posts an error reply.
  return finished(
    owner,
    owner.delivery === "junior" || owner.quietFailure ? undefined : ERROR_REPLY,
    "failed",
  );
}

/** The wakes of work that throws on every attempt until the last one. */
function failedAttempts(owner: Owner): string[] {
  return (
    owner.failedWakes ?? [
      ...Array.from(
        { length: CONVERSATION_WORK_MAX_RETRIES - 1 },
        () => "failed",
      ),
      "completed",
    ]
  );
}

/** What a finished Turn shows on its owner. */
function finished(
  owner: Owner,
  text: unknown,
  end: "blocked" | "completed" | "failed" | "stopped",
) {
  if (owner.delivery === "parent") {
    // A child has no Delivery. It reports its end to the parent once.
    return {
      invocation: end,
      parentMailbox: "appended",
      reportsToParent: 1,
      // No Turn of an ended child can resume.
      turnRecordOpen: false,
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
      wakes: failedAttempts(owner),
      turn: "failed",
      shown: failed(owner),
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
      shown: failed(owner),
    }),
  },
  {
    name: "stop before the Run",
    outputs: ({ reply }) => [reply("Never sent.")],
    before: async ({ stop }) => stop(),
    expected: (owner) => ({
      wakes: ["completed", "no_work"],
      turn: "stopped",
      shown: finished(owner, undefined, "stopped"),
    }),
  },
  {
    name: "stop after the Run keeps the result",
    outputs: ({ reply }) => [reply(REPLY)],
    stopAfterRun: true,
    expected: (owner) => ({
      wakes: ["completed", "no_work"],
      turn: "completed",
      shown: finished(owner, REPLY, "completed"),
    }),
  },
  {
    // The child still has an open child agent, so its saved result waits
    // for that work. The stop ends that work, so the result reports now.
    name: "an error after the save while a stop is pending",
    appliesTo: isChild,
    outputs: ({ reply }) => [reply(REPLY)],
    before: async ({ conversationId }) => {
      await createAgentInvocation({
        ...invocationInput,
        idempotencyKey: `${conversationId}-open-child`,
        parentConversationId: conversationId,
      });
    },
    stopAfterRun: true,
    lifecycleFailure: "complete",
    expected: (owner) => ({
      // The failed write retries the attempt. The retry reports the saved
      // result.
      wakes: ["failed", "completed", "no_work"],
      turn: "completed",
      shown: finished(owner, REPLY, "completed"),
    }),
  },
  {
    name: "an execution limit fails at once",
    outputs: () => [],
    failFromWake: 0,
    failure: () => new TurnToolCallLimitExceededError(1),
    expected: (owner) => ({
      wakes: ["completed"],
      turn: "failed",
      shown: failed(owner),
    }),
  },
  {
    name: "a setup error fails on the last attempt",
    outputs: ({ reply }) => [reply("Never sent.")],
    lifecycleFailure: "start",
    expected: (owner) => ({
      wakes: failedAttempts(owner),
      turn: "failed",
      shown: failed(owner),
    }),
  },
  {
    name: "an auth pause blocks the child",
    appliesTo: isChild,
    outputs: () => [],
    outcome: { providerDisplayName: "GitHub", status: "awaiting_auth" },
    expected: (owner) => ({
      wakes: ["completed"],
      turn: "blocked",
      shown: finished(owner, undefined, "blocked"),
    }),
  },
];
