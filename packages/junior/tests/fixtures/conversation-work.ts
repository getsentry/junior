import type { Lock, StateAdapter } from "chat";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
  createFauxCore,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import type { Destination } from "@sentry/junior-plugin-api";
import { createConversationWork } from "@/chat/app/conversation-work";
import { executeAgentRun } from "@/chat/agent";
import { hydrateConversationMessages } from "@/chat/conversations/messages";
import { getConversationStore } from "@/chat/db";
import type { AgentRunner } from "@/chat/runtime/agent-runner";
import { runWithTurnRequestDeadline } from "@/chat/runtime/request-deadline";
import { getPersistedThreadState } from "@/chat/runtime/thread-state";
import { getStateAdapter } from "@/chat/state/adapter";
import {
  coerceThreadConversationState,
  type ThreadConversationState,
} from "@/chat/state/conversation";
import type {
  ConversationQueueMessage,
  ConversationQueueSendOptions,
  ConversationWorkQueue,
} from "@/chat/task-execution/queue";
import {
  CONVERSATION_BY_ACTIVITY_INDEX_KEY,
  type InboundMessage,
} from "@/chat/task-execution/store";
import { processConversationQueueMessage } from "@/chat/task-execution/vercel-callback";
import { handleSlackWebhook } from "@/chat/ingress/slack-webhook";
import { createJuniorSlackAdapter } from "@/chat/slack/adapter";
import { slackApiOutbox } from "./slack-api-outbox";
import { createSlackWebhookTestClient } from "./slack/webhook-client";
import { createWaitUntilCollector } from "./wait-until";
import { getCapturedSlackApiCalls } from "../msw/handlers/slack-api";
import { readProxyProperty } from "./proxy-property";

export const CONVERSATION_ID = "slack:C123:1712345.0001";
export const SLACK_DESTINATION = {
  platform: "slack",
  teamId: "T123",
  channelId: "C123",
} as const satisfies Destination;
export const SLACK_BOT_USER_ID = "U0BOT";
export const SLACK_SIGNING_SECRET = "slack-signature-fixture";

export interface ConversationQueueSendRecord {
  conversationId: string;
  delayMs?: number;
  idempotencyKey?: string;
}

interface QueueSendHold {
  entered: () => void;
  release: Promise<unknown>;
}

/**
 * In-memory queue adapter for tests that need queue delivery plus send introspection.
 *
 * `send` behaves like the production queue handoff: it records send attempts and
 * makes accepted payloads available for callback-style delivery through
 * `takeMessage`.
 */
export class ConversationWorkQueueTestAdapter implements ConversationWorkQueue {
  #idempotentMessageIds = new Map<string, string>();
  #queuedMessages: ConversationQueueMessage[] = [];
  #rejectSends = false;
  #sendHolds: QueueSendHold[] = [];
  #sendAttempts: ConversationQueueSendRecord[] = [];
  #sentRecords: ConversationQueueSendRecord[] = [];

  allowSends(): void {
    this.#rejectSends = false;
  }

  clearSentRecords(): void {
    this.#sendAttempts = [];
    this.#sentRecords = [];
  }

  hasQueuedMessages(): boolean {
    return this.#queuedMessages.length > 0;
  }

  queuedMessages(): ConversationQueueMessage[] {
    return this.#queuedMessages.map((message) => ({ ...message }));
  }

  rejectSends(): void {
    this.#rejectSends = true;
  }

  sendAttempts(): ConversationQueueSendRecord[] {
    return this.#sendAttempts.map((record) => ({ ...record }));
  }

  sentRecords(): ConversationQueueSendRecord[] {
    return this.#sentRecords.map((record) => ({ ...record }));
  }

  /** Hold the next send open after it records the queued payload. */
  holdNextSendUntil(release: Promise<unknown>): Promise<void> {
    return new Promise((entered) => {
      this.#sendHolds.push({ entered, release });
    });
  }

  async send(
    message: ConversationQueueMessage,
    options?: ConversationQueueSendOptions,
  ): Promise<{ messageId: string }> {
    if (this.#rejectSends) {
      throw new Error("queue unavailable");
    }
    const record: ConversationQueueSendRecord = {
      conversationId: message.conversationId,
    };
    if (options?.delayMs !== undefined) {
      record.delayMs = options.delayMs;
    }
    if (options?.idempotencyKey !== undefined) {
      record.idempotencyKey = options.idempotencyKey;
    }
    this.#sendAttempts.push(record);
    const duplicateMessageId = options?.idempotencyKey
      ? this.#idempotentMessageIds.get(options.idempotencyKey)
      : undefined;
    if (duplicateMessageId) {
      return { messageId: duplicateMessageId };
    }
    const messageId = `queue-${this.#sentRecords.length + 1}`;
    this.#queuedMessages.push({ ...message });
    this.#sentRecords.push(record);
    if (options?.idempotencyKey) {
      this.#idempotentMessageIds.set(options.idempotencyKey, messageId);
    }
    const hold = this.#sendHolds.shift();
    if (hold) {
      hold.entered();
      await hold.release;
    }
    return { messageId };
  }

  takeMessage(): ConversationQueueMessage {
    const message = this.#queuedMessages.shift();
    if (!message) {
      throw new Error("Expected queued conversation work payload");
    }
    return message;
  }
}

/** Create a durable queue adapter for component and integration tests. */
export function createConversationWorkQueueTestAdapter(): ConversationWorkQueueTestAdapter {
  return new ConversationWorkQueueTestAdapter();
}

/** Observe whether one conversation's mutation lock is currently held. */
export function observeConversationMutationLock(args: {
  conversationId: string;
  state: StateAdapter;
}): { isHeld: () => boolean; state: StateAdapter } {
  const mutationLockKey = `junior:conversation:v2:mutation:${args.conversationId}`;
  const locks = new WeakSet<Lock>();
  let held = false;
  return {
    isHeld: () => held,
    state: new Proxy(args.state, {
      get(target, prop) {
        if (prop === "acquireLock") {
          return async (key: string, ttlMs: number) => {
            const lock = await target.acquireLock(key, ttlMs);
            if (lock && key === mutationLockKey) {
              locks.add(lock);
              held = true;
            }
            return lock;
          };
        }
        if (prop === "releaseLock") {
          return async (lock: Lock) => {
            try {
              return await target.releaseLock(lock);
            } finally {
              if (locks.delete(lock)) {
                held = false;
              }
            }
          };
        }
        const value = readProxyProperty(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as StateAdapter,
  };
}

/** Acquire the conversation mutation lock through the shared test fixture. */
export async function acquireConversationMutationLock(args: {
  conversationId: string;
  state: StateAdapter;
  ttlMs?: number;
}): Promise<Lock | null> {
  return await args.state.acquireLock(
    `junior:conversation:v2:mutation:${args.conversationId}`,
    args.ttlMs ?? 10_000,
  );
}

/** Build a durable mailbox record for component-level conversation work tests. */
export function inboundMessage(
  inboundMessageId: string,
  overrides: Partial<InboundMessage> = {},
): InboundMessage {
  return {
    conversationId: CONVERSATION_ID,
    inboundMessageId,
    destination: SLACK_DESTINATION,
    delivery: "interrupt",
    source: "slack",
    createdAtMs: 1_000,
    receivedAtMs: 1_100,
    publishExternally: true,
    input: {
      text: `message ${inboundMessageId}`,
      authorId: "U123",
    },
    ...overrides,
  };
}

/** Build a durable queue payload for the default Slack conversation fixture. */
export function conversationQueueMessage(
  overrides: Partial<ConversationQueueMessage> = {},
): ConversationQueueMessage {
  return {
    schemaVersion: 2,
    conversationId: CONVERSATION_ID,
    ...overrides,
  };
}

/** Delay the global work index lock once so retry behavior is observable. */
export function delayIndexLockOnce(state: StateAdapter): StateAdapter {
  let blocked = false;
  const indexLockKey = `${CONVERSATION_BY_ACTIVITY_INDEX_KEY}:lock`;
  return new Proxy(state, {
    get(target, prop) {
      if (prop === "acquireLock") {
        return async (key: string, ttlMs: number) => {
          if (!blocked && key === indexLockKey) {
            blocked = true;
            return null;
          }
          return target.acquireLock(key, ttlMs);
        };
      }
      const value = readProxyProperty(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as StateAdapter;
}

/** Delay one conversation's mutation lock until the fake clock reaches a point. */
export function delayMutationLockUntil(args: {
  conversationId: string;
  readyAtMs: number;
  state: StateAdapter;
}): StateAdapter {
  const mutationLockKey = `junior:conversation:v2:mutation:${args.conversationId}`;
  return new Proxy(args.state, {
    get(target, prop) {
      if (prop === "acquireLock") {
        return async (key: string, ttlMs: number) => {
          if (key === mutationLockKey && Date.now() < args.readyAtMs) {
            return null;
          }
          return target.acquireLock(key, ttlMs);
        };
      }
      const value = readProxyProperty(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as StateAdapter;
}

/** Build a signed Slack JSON webhook request for Slack ingress tests. */
export function slackWebhookRequest(body: unknown): Request {
  return createSlackWebhookTestClient({
    signingSecret: SLACK_SIGNING_SECRET,
  }).event(body);
}

/** Build the minimal Slack Events API envelope used by durable ingress tests. */
export function slackEnvelope(input: {
  channel?: string;
  eventType?: "app_mention" | "message";
  text?: string;
  threadTs?: string;
  ts?: string;
  user?: string;
}) {
  const channel = input.channel ?? "C123";
  const ts = input.ts ?? "1712345.0001";
  return {
    team_id: "T123",
    type: "event_callback",
    event: {
      type: input.eventType ?? "app_mention",
      user: input.user ?? "U123",
      text: input.text ?? `<@${SLACK_BOT_USER_ID}> hello`,
      channel,
      ts,
      event_ts: ts,
      channel_type: channel.startsWith("D") ? "im" : "channel",
      ...(input.threadTs ? { thread_ts: input.threadTs } : undefined),
    },
  };
}

/** Create a manually-resolved promise for coordinating async worker tests. */
export function deferred<T = void>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

/** Run Slack webhook ingress and flush every scheduled waitUntil task. */
export async function handleSlackWebhookAndFlush(
  args: Omit<Parameters<typeof handleSlackWebhook>[0], "waitUntil">,
): Promise<Response> {
  const waitUntil = createWaitUntilCollector();
  const response = await handleSlackWebhook({
    ...args,
    waitUntil: waitUntil.fn,
  });
  await waitUntil.flush();
  return response;
}

/** Create a Slack adapter that shares the signed-request fixture credentials. */
export function createSlackAdapterFixture() {
  return createJuniorSlackAdapter({
    botToken: "slack-bot-fixture",
    botUserId: SLACK_BOT_USER_ID,
    signingSecret: SLACK_SIGNING_SECRET,
  });
}

/** Provide no-op Slack runtime handlers when tests only care about ingress. */
export function createNoopSlackWebhookRuntime() {
  return {
    handleAssistantContextChanged: async () => {},
    handleAssistantThreadStarted: async () => {},
    handleNewMention: async () => {},
    handleSubscribedMessage: async () => {},
  };
}

export const THREAD_TS = "1712345.0001";

export type ModelStreamStep =
  | string
  | { tool: string; args?: Record<string, unknown> }
  | (() => Promise<ReturnType<typeof fauxAssistantMessage>>);

function buildStreamResponses(steps: ModelStreamStep[]) {
  return steps.map((step) => {
    if (typeof step === "function") {
      return step;
    }
    if (typeof step === "string") {
      return fauxAssistantMessage(step);
    }
    return fauxAssistantMessage([fauxToolCall(step.tool, step.args ?? {})], {
      stopReason: "toolUse",
    });
  });
}

/** Model stream that returns one completed assistant reply per call. */
export function streamReplies(...texts: string[]): StreamFn {
  const faux = createFauxCore({ api: "test", provider: "test" });
  const built = buildStreamResponses(texts);
  if (built.length === 0) {
    throw new Error("streamReplies requires at least one reply");
  }
  faux.setResponses(built);
  return faux.stream;
}

/**
 * Queue model steps and repeat the last reply for resume / follow-up model
 * calls in the same agent run. Fake only generation; tools still run for real.
 */
export function streamScript(...steps: ModelStreamStep[]): StreamFn {
  const faux = createFauxCore({ api: "test", provider: "test" });
  const built = buildStreamResponses(steps);
  const last = built.at(-1);
  if (!last) {
    throw new Error("streamScript requires at least one step");
  }
  faux.setResponses([...built, ...Array.from({ length: 12 }, () => last)]);
  return faux.stream;
}

export type ConversationWorkSlackHarness = {
  agentRunner: AgentRunner;
  state: StateAdapter;
  wakes: ConversationWorkQueueTestAdapter;
  replies: () => string[];
  authLinksFor: (userId: string) => ReturnType<typeof getCapturedSlackApiCalls>;
  setModelStream: (next: StreamFn) => void;
  setSubscribedShouldReply: (shouldReply: boolean) => void;
  next: (
    requestStartedAtMs?: number,
  ) => Promise<Awaited<ReturnType<typeof processConversationQueueMessage>>>;
  drain: () => Promise<void>;
  send: (input?: {
    eventType?: "app_mention" | "message";
    text?: string;
    threadTs?: string;
    ts?: string;
    user?: string;
  }) => Promise<Response>;
  mention: (user: string, text: string) => Promise<string>;
  /** Non-mention thread message (subscribed path). */
  passive: (user: string, text: string) => Promise<string>;
};

/**
 * Compose the production Slack ingress → durable queue → worker → agent path.
 * Fake only model generation at the executeAgentRun stream boundary and Slack
 * HTTP at the adapter boundary.
 */
export async function createConversationWorkSlackHarness(
  options: {
    agentRunner?: AgentRunner;
    modelStream?: StreamFn;
    /** Default subscribed-message classifier outcome. */
    subscribedShouldReply?: boolean;
  } = {},
): Promise<ConversationWorkSlackHarness> {
  const state = getStateAdapter();
  await state.connect();
  const wakes = createConversationWorkQueueTestAdapter();
  const adapter = createSlackAdapterFixture();
  let modelStream = options.modelStream ?? streamReplies("Deploy checked.");
  let subscribedShouldReply = options.subscribedShouldReply ?? false;
  const agentRunner: AgentRunner = options.agentRunner ?? {
    run: async (request) => await executeAgentRun(request, modelStream),
  };
  const work = createConversationWork({
    agentRunner,
    conversationStore: getConversationStore(),
    getSlackAdapter: () => adapter,
    queue: wakes,
    services: {
      replyExecutor: { agentRunner },
      subscribedReplyPolicy: {
        completeObject: async ({ schema }) => ({
          object: schema.parse({
            should_reply: subscribedShouldReply,
            should_unsubscribe: false,
            confidence: 1,
            reason: subscribedShouldReply
              ? "test_follow_up"
              : "side_conversation",
          }),
        }),
      },
      visionContext: {
        listThreadReplies: async () => [],
      },
    },
    state,
  });

  let messageSeq = 0;
  const nextTs = () => {
    messageSeq += 1;
    return `1712345.${String(messageSeq).padStart(4, "0")}`;
  };

  const services = {
    getSlackAdapter: () => adapter,
    queue: wakes,
    runtime: work.runtime,
    state,
  };

  const post = async (input: {
    eventType: "app_mention" | "message";
    user: string;
    text: string;
  }) => {
    const ts = nextTs();
    const mention = input.eventType === "app_mention";
    await handleSlackWebhookAndFlush({
      request: slackWebhookRequest(
        slackEnvelope({
          eventType: input.eventType,
          text: mention ? `<@${SLACK_BOT_USER_ID}> ${input.text}` : input.text,
          threadTs: THREAD_TS,
          ts,
          user: input.user,
        }),
      ),
      services,
    });
    return ts;
  };

  return {
    agentRunner,
    state,
    wakes,
    setModelStream(next: StreamFn) {
      modelStream = next;
    },
    setSubscribedShouldReply(shouldReply: boolean) {
      subscribedShouldReply = shouldReply;
    },
    replies: () =>
      slackApiOutbox
        .messages()
        .map((call) => call.params.text)
        .filter((text): text is string => typeof text === "string"),
    authLinksFor: (userId: string) =>
      getCapturedSlackApiCalls("chat.postEphemeral").filter(
        (call) => String(call.params.user ?? "") === userId,
      ),
    next: async (requestStartedAtMs?: number) => {
      const process = async () =>
        await processConversationQueueMessage(wakes.takeMessage(), {
          queue: wakes,
          run: work.run,
          state,
        });
      return requestStartedAtMs === undefined
        ? await process()
        : await runWithTurnRequestDeadline(process, requestStartedAtMs);
    },
    drain: async () => {
      for (let i = 0; i < 12 && wakes.hasQueuedMessages(); i += 1) {
        await processConversationQueueMessage(wakes.takeMessage(), {
          queue: wakes,
          run: work.run,
          state,
        });
      }
      if (wakes.hasQueuedMessages()) {
        throw new Error("queue still has work after drain");
      }
    },
    send: async (input = {}) =>
      await handleSlackWebhookAndFlush({
        request: slackWebhookRequest(
          slackEnvelope({
            text: `<@${SLACK_BOT_USER_ID}> inspect the deploy`,
            ...input,
          }),
        ),
        services,
      }),
    mention: async (user: string, text: string) =>
      await post({ eventType: "app_mention", user, text }),
    passive: async (user: string, text: string) =>
      await post({ eventType: "message", user, text }),
  };
}

/** Load the fixture conversation's persisted thread state with messages. */
export async function loadConversationState(
  conversationId = CONVERSATION_ID,
): Promise<ThreadConversationState> {
  const conversation = coerceThreadConversationState(
    await getPersistedThreadState(conversationId),
  );
  await hydrateConversationMessages({
    conversation,
    conversationId,
  });
  return conversation;
}
