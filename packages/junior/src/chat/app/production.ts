import type { SlackAdapter } from "@chat-adapter/slack";
import { createSlackRuntime } from "@/chat/app/factory";
import { withSandboxTracePropagation } from "@/chat/app/services";
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
import { createSlackConversationWorker } from "@/chat/task-execution/slack-work";
import { getVercelConversationWorkQueue } from "@/chat/task-execution/vercel-queue";
import type { VercelConversationWorkCallbackOptions } from "@/chat/task-execution/vercel-callback";
import { resumeAwaitingSlackContinuation } from "@/chat/runtime/agent-continue-runner";
import type { JuniorRuntimeServiceOverrides } from "@/chat/app/services";
import { generateAssistantReply } from "@/chat/respond";

let productionSlackAdapter: SlackAdapter | undefined;
let productionSlackRuntime: ReturnType<typeof createSlackRuntime> | undefined;

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
    ...(botToken ? { botToken } : {}),
    ...(clientId ? { clientId } : {}),
    ...(clientSecret ? { clientSecret } : {}),
  });
}

/** Return the lazily initialized production Slack adapter. */
export function getProductionSlackAdapter(): SlackAdapter {
  productionSlackAdapter ??= createProductionSlackAdapter();
  return productionSlackAdapter;
}

/** Return the lazily initialized production Slack runtime. */
export function getProductionSlackRuntime(): ReturnType<
  typeof createSlackRuntime
> {
  productionSlackRuntime ??= createSlackRuntime({
    getSlackAdapter: getProductionSlackAdapter,
  });
  return productionSlackRuntime;
}

/** Create production-backed services for Slack webhook ingress. */
export function createProductionSlackWebhookServices(options?: {
  services?: JuniorRuntimeServiceOverrides;
}): SlackWebhookServices {
  const runtime = createSlackRuntime({
    getSlackAdapter: getProductionSlackAdapter,
    services: options?.services,
  });
  return {
    getSlackAdapter: getProductionSlackAdapter,
    getUserTokenStore: createUserTokenStore,
    queue: getVercelConversationWorkQueue(),
    runtime,
  };
}

/** Return production services for Slack webhook ingress. */
export function getProductionSlackWebhookServices(): SlackWebhookServices {
  return {
    getSlackAdapter: getProductionSlackAdapter,
    getUserTokenStore: createUserTokenStore,
    queue: getVercelConversationWorkQueue(),
    runtime: getProductionSlackRuntime(),
  };
}

/** Return the production queue callback options for conversation work. */
export function createProductionConversationWorkOptions(options?: {
  services?: JuniorRuntimeServiceOverrides;
}): VercelConversationWorkCallbackOptions {
  const runtime = createSlackRuntime({
    getSlackAdapter: getProductionSlackAdapter,
    services: options?.services,
  });
  return {
    queue: getVercelConversationWorkQueue(),
    run: createSlackConversationWorker({
      getSlackAdapter: getProductionSlackAdapter,
      resumeAwaitingContinuation: async (conversationId) =>
        await resumeAwaitingSlackContinuation(conversationId, {
          generateReply: withSandboxTracePropagation(
            generateAssistantReply,
            options?.services?.sandbox?.tracePropagation,
          ),
        }),
      runtime,
    }),
  };
}
