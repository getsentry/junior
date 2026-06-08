import type { Lock, StateAdapter } from "chat";
import type { Destination } from "@sentry/junior-plugin-api";
import type {
  ConversationQueueMessage,
  ConversationQueueSendOptions,
  ConversationWorkQueue,
} from "@/chat/task-execution/queue";
import {
  CONVERSATION_BY_ACTIVITY_INDEX_KEY,
  type InboundMessage,
} from "@/chat/task-execution/store";
import { handleSlackWebhook } from "@/chat/ingress/slack-webhook";
import { createJuniorSlackAdapter } from "@/chat/slack/adapter";
import { createSlackWebhookTestClient } from "./slack/webhook-client";
import { createWaitUntilCollector } from "./wait-until";

export const CONVERSATION_ID = "slack:C123:1712345.0001";
export const SLACK_DESTINATION = {
  platform: "slack",
  teamId: "T123",
  channelId: "C123",
} as const satisfies Destination;
export const SLACK_BOT_USER_ID = "U_BOT";
export const SLACK_SIGNING_SECRET = "slack-signature-fixture";

export interface ConversationQueueSendRecord {
  conversationId: string;
  destination: Destination;
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
      destination: message.destination,
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
  const mutationLockKey = `junior:conversation:mutation:${args.conversationId}`;
  const locks = new WeakSet<Lock>();
  let held = false;
  return {
    isHeld: () => held,
    state: new Proxy(args.state, {
      get(target, prop, receiver) {
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
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as StateAdapter,
  };
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
    source: "slack",
    createdAtMs: 1_000,
    receivedAtMs: 1_100,
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
    conversationId: CONVERSATION_ID,
    destination: SLACK_DESTINATION,
    ...overrides,
  };
}

/** Delay the global work index lock once so retry behavior is observable. */
export function delayIndexLockOnce(state: StateAdapter): StateAdapter {
  let blocked = false;
  const indexLockKey = `${CONVERSATION_BY_ACTIVITY_INDEX_KEY}:lock`;
  return new Proxy(state, {
    get(target, prop, receiver) {
      if (prop === "acquireLock") {
        return async (key: string, ttlMs: number) => {
          if (!blocked && key === indexLockKey) {
            blocked = true;
            return null;
          }
          return target.acquireLock(key, ttlMs);
        };
      }
      const value = Reflect.get(target, prop, receiver);
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
  const mutationLockKey = `junior:conversation:mutation:${args.conversationId}`;
  return new Proxy(args.state, {
    get(target, prop, receiver) {
      if (prop === "acquireLock") {
        return async (key: string, ttlMs: number) => {
          if (key === mutationLockKey && Date.now() < args.readyAtMs) {
            return null;
          }
          return target.acquireLock(key, ttlMs);
        };
      }
      const value = Reflect.get(target, prop, receiver);
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
}) {
  const channel = input.channel ?? "C123";
  const ts = input.ts ?? "1712345.0001";
  return {
    team_id: "T123",
    type: "event_callback",
    event: {
      type: input.eventType ?? "app_mention",
      user: "U123",
      text: input.text ?? `<@${SLACK_BOT_USER_ID}> hello`,
      channel,
      ts,
      event_ts: ts,
      channel_type: channel.startsWith("D") ? "im" : "channel",
      ...(input.threadTs ? { thread_ts: input.threadTs } : {}),
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
