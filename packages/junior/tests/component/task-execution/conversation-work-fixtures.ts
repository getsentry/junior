import { createHmac } from "node:crypto";
import type { StateAdapter } from "chat";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";
import type { InboundMessageRecord } from "@/chat/task-execution/store";
import { handleSlackWebhook } from "@/chat/ingress/slack-webhook";
import { createJuniorSlackAdapter } from "@/chat/slack/adapter";
import type { WaitUntilFn } from "@/handlers/types";

export const CONVERSATION_ID = "slack:C123:1712345.0001";
export const SLACK_BOT_USER_ID = "U_BOT";

const SLACK_SIGNING_SECRET = "slack-signature-fixture";

export class FakeQueue implements ConversationWorkQueue {
  fail = false;
  sent: Array<{
    conversationId: string;
    delayMs?: number;
    idempotencyKey?: string;
  }> = [];

  async send(
    message: { conversationId: string },
    options?: { delayMs?: number; idempotencyKey?: string },
  ): Promise<{ messageId: string }> {
    if (this.fail) {
      throw new Error("queue unavailable");
    }
    this.sent.push({
      conversationId: message.conversationId,
      delayMs: options?.delayMs,
      idempotencyKey: options?.idempotencyKey,
    });
    return { messageId: `queue-${this.sent.length}` };
  }
}

export function inboundMessage(
  inboundMessageId: string,
  overrides: Partial<InboundMessageRecord> = {},
): InboundMessageRecord {
  return {
    conversationId: CONVERSATION_ID,
    inboundMessageId,
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

export function delayIndexLockOnce(state: StateAdapter): StateAdapter {
  let blocked = false;
  return new Proxy(state, {
    get(target, prop, receiver) {
      if (prop === "acquireLock") {
        return async (key: string, ttlMs: number) => {
          if (!blocked && key === "junior:conversation-work:index:lock") {
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

export function delayMutationLockUntil(args: {
  conversationId: string;
  readyAtMs: number;
  state: StateAdapter;
}): StateAdapter {
  const mutationLockKey = `junior:conversation-work:mutation:${args.conversationId}`;
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

function signSlackBody(body: string, timestamp: string): string {
  return `v0=${createHmac("sha256", SLACK_SIGNING_SECRET)
    .update(`v0:${timestamp}:${body}`)
    .digest("hex")}`;
}

export function slackWebhookRequest(body: unknown): Request {
  const serialized = JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / 1000));
  return new Request("https://example.test/api/webhooks/slack", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": signSlackBody(serialized, timestamp),
    },
    body: serialized,
  });
}

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

export function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

type WaitUntilTask = () => Promise<unknown>;

function collectWaitUntil(tasks: WaitUntilTask[]): WaitUntilFn {
  return (task) => {
    tasks.push(typeof task === "function" ? task : () => task);
  };
}

async function flushWaitUntil(tasks: WaitUntilTask[]): Promise<void> {
  for (let index = 0; index < tasks.length; index += 1) {
    await tasks[index]?.();
  }
}

export async function handleSlackWebhookAndFlush(
  args: Omit<Parameters<typeof handleSlackWebhook>[0], "waitUntil">,
): Promise<Response> {
  const waitUntilTasks: WaitUntilTask[] = [];
  const response = await handleSlackWebhook({
    ...args,
    waitUntil: collectWaitUntil(waitUntilTasks),
  });
  await flushWaitUntil(waitUntilTasks);
  return response;
}

export function createSlackAdapterFixture() {
  return createJuniorSlackAdapter({
    botToken: "slack-bot-fixture",
    botUserId: SLACK_BOT_USER_ID,
    signingSecret: SLACK_SIGNING_SECRET,
  });
}

export function createNoopSlackWebhookRuntime() {
  return {
    handleAssistantContextChanged: async () => {},
    handleAssistantThreadStarted: async () => {},
    handleNewMention: async () => {},
    handleSubscribedMessage: async () => {},
  };
}
