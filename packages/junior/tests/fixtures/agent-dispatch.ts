import { createHmac } from "node:crypto";

/** Build a rollout-compatible signed dispatch callback request. */
export function createSignedDispatchCallbackRequest(
  payload: { expectedVersion: number; id: string },
  options?: { secret?: string; signature?: string },
): Request {
  const body = JSON.stringify(payload);
  const timestamp = Date.now().toString();
  const digest = createHmac("sha256", options?.secret ?? "dispatch-secret")
    .update(`junior.agent_dispatch.v1:${timestamp}:${body}`)
    .digest("hex");
  return new Request("https://junior.example.com/api/internal/agent-dispatch", {
    method: "POST",
    headers: {
      "x-junior-dispatch-signature": options?.signature ?? `v1=${digest}`,
      "x-junior-dispatch-timestamp": timestamp,
    },
    body,
  });
}

import {
  createSlackSource,
  type ReplyAttribution,
  type Source,
} from "@sentry/junior-plugin-api";
import { createOrGetDispatch } from "@/chat/agent-dispatch/store";
import { buildAgentDispatchInboundMessage } from "@/chat/agent-dispatch/work";
import type { ConversationWorkerContext } from "@/chat/task-execution/worker";
import { createSlackRuntime } from "@/chat/app/factory";
import { createJuniorSlackAdapter } from "@/chat/slack/adapter";
import type { CredentialSubject } from "@/chat/credentials/context";
import type { JuniorRuntimeServiceOverrides } from "@/chat/app/services";
import { vi } from "vitest";

export const agentDispatchTestDestination = {
  platform: "slack",
  teamId: "T123",
  channelId: "C123",
} as const;

/** Build a Slack runtime with a test adapter and the provided reply executor. */
export function createAgentDispatchTestRuntime(
  replyExecutor: NonNullable<JuniorRuntimeServiceOverrides["replyExecutor"]>,
) {
  return createSlackRuntime({
    getSlackAdapter: () =>
      createJuniorSlackAdapter({
        botToken: "xoxb-test",
        botUserId: "U0BOT",
        signingSecret: "test-signing-secret",
      }),
    services: { replyExecutor },
  });
}

/** Create a durable dispatch record for integration tests. */
export async function createAgentDispatchTestRecord(
  idempotencyKey: string,
  credentialSubject?: CredentialSubject,
  source?: Source,
  replyAttribution?: ReplyAttribution,
  input = "Post the scheduled digest.",
) {
  return (
    await createOrGetDispatch({
      nowMs: Date.now(),
      options: {
        destination: agentDispatchTestDestination,
        destinationVisibility: "private",
        ...(credentialSubject ? { credentialSubject } : {}),
        idempotencyKey,
        input,
        ...(replyAttribution ? { replyAttribution } : {}),
        source:
          source ??
          createSlackSource({
            ...agentDispatchTestDestination,
            visibility: "private",
          }),
      },
      plugin: "scheduler",
    })
  ).record;
}

/** Build a conversation-worker context around one dispatch inbound message. */
export function createAgentDispatchWorkerContext(
  dispatch: Awaited<ReturnType<typeof createAgentDispatchTestRecord>>,
  overrides: Partial<ConversationWorkerContext> = {},
) {
  const ack = vi.fn(async () => {});
  const message = buildAgentDispatchInboundMessage(dispatch);
  const context: ConversationWorkerContext = {
    attempt: {
      ack,
      conversationId: message.conversationId,
      destination: agentDispatchTestDestination,
      drain: vi.fn(async () => []),
      isFinalAttempt: false,
      messages: [message],
    },
    checkIn: vi.fn(async () => true),
    conversationId: message.conversationId,
    destination: agentDispatchTestDestination,
    shouldYield: () => false,
    ...overrides,
  };
  return { ack, context };
}
