import type { SlackAdapter } from "@chat-adapter/slack";
import { createSlackRuntime } from "@/chat/app/factory";
import type { AgentRunner } from "@/chat/runtime/agent-runner";
import { createUserTokenStore } from "@/chat/capabilities/factory";
import {
  getSlackBotToken,
  getSlackClientId,
  getSlackClientSecret,
  getSlackSigningSecret,
} from "@/chat/config";
import { createChatSdkLogger } from "@/chat/logging";
import { createJuniorSlackAdapter } from "@/chat/slack/adapter";
import type { SlackWebhookServices } from "@/chat/ingress/slack-webhook";
import type { JuniorRuntimeServiceOverrides } from "@/chat/app/services";
import { getConversationStore } from "@/chat/db";
import type { ConversationStore } from "@/chat/conversations/store";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";
import {
  createConversationWork,
  type ConversationWorkCallbackOptions,
} from "@/chat/app/conversation-work";

let productionSlackAdapter: SlackAdapter | undefined;

function createProductionSlackAdapter(): SlackAdapter {
  const signingSecret = getSlackSigningSecret();
  const botToken = getSlackBotToken();
  const clientId = getSlackClientId();
  const clientSecret = getSlackClientSecret();

  if (!signingSecret) {
    throw new Error("SLACK_SIGNING_SECRET is required");
  }

  return createJuniorSlackAdapter({
    logger: createChatSdkLogger().child("slack"),
    signingSecret,
    ...(botToken ? { botToken } : undefined),
    ...(clientId ? { clientId } : undefined),
    ...(clientSecret ? { clientSecret } : undefined),
  });
}

/** Return the lazily initialized production Slack adapter. */
export function getProductionSlackAdapter(): SlackAdapter {
  productionSlackAdapter ??= createProductionSlackAdapter();
  return productionSlackAdapter;
}

/** Return the production conversation store for current config. */
export function getProductionConversationStore(): ConversationStore {
  return getConversationStore();
}

/** Create production-backed services for Slack webhook ingress. */
export function createProductionSlackWebhookServices(options: {
  queue: ConversationWorkQueue;
  services?: JuniorRuntimeServiceOverrides;
}): SlackWebhookServices {
  const conversationStore = getProductionConversationStore();
  const runtime = createSlackRuntime({
    getSlackAdapter: getProductionSlackAdapter,
    services: options?.services,
  });
  return {
    getSlackAdapter: getProductionSlackAdapter,
    getUserTokenStore: createUserTokenStore,
    conversationStore,
    queue: options.queue,
    runtime,
  };
}

/** Return the production queue callback options for conversation work. */
export function createProductionConversationWorkOptions(options: {
  agentRunner: AgentRunner;
  queue: ConversationWorkQueue;
  services?: JuniorRuntimeServiceOverrides;
  waitUntil: (task: Promise<unknown>) => void;
}): ConversationWorkCallbackOptions {
  const conversationStore = getProductionConversationStore();
  return {
    ...createConversationWork({
      agentRunner: options.agentRunner,
      conversationStore,
      getSlackAdapter: getProductionSlackAdapter,
      queue: options.queue,
      services: options.services,
    }),
    waitUntil: options.waitUntil,
  };
}
