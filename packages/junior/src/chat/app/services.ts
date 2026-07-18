import type { SlackAdapter } from "@chat-adapter/slack";
import { completeObject, completeText } from "@/chat/pi/client";
import { executeAgentRun as executeAgentRunImpl } from "@/chat/agent";
import type { SandboxEgressTracePropagationConfig } from "@/chat/sandbox/egress/tracing";
import {
  getAwaitingAgentContinueRequest,
  scheduleAgentContinue,
} from "@/chat/services/agent-continue";
import { scheduleSessionCompletedPluginTasks } from "@/chat/plugins/task-runner";
import {
  createConversationMemoryService,
  type ConversationMemoryDeps,
  type ConversationMemoryService,
} from "@/chat/services/conversation-memory";
import {
  createContextCompactor,
  type ContextCompactor,
  type ContextCompactorDeps,
} from "@/chat/services/context-compaction";
import { downloadPrivateSlackFile } from "@/chat/slack/client";
import { listThreadReplies } from "@/chat/slack/channel";
import { lookupSlackUser } from "@/chat/slack/user";
import {
  createSubscribedReplyPolicy,
  type SubscribedReplyPolicy,
  type SubscribedReplyPolicyDeps,
} from "@/chat/services/subscribed-reply-policy";
import type { ReplyExecutorServices } from "@/chat/runtime/reply-executor";
import {
  createVisionContextService,
  type VisionContextDeps,
  type VisionContextService,
} from "@/chat/slack/vision-context";
import { createAgentRunner } from "@/chat/runtime/agent-runner";
import { getSqlExecutor } from "@/chat/db";
import {
  postRecoverableSlackMessage,
  reconcileRecoverableSlackMessage,
} from "@/chat/slack/outbound";
import { RecoverableSlackDeliveryService } from "@/chat/slack/recoverable-delivery";
import type {
  RecoverableSlackDelivery,
  RecoverableSlackDeliveryPort,
} from "@/chat/slack/recoverable-delivery";
import { ConversationTurnLifecycleService } from "@/chat/conversations/turn-lifecycle";
import { getConversationEventStore } from "@/chat/db";
import { runWithSlackInstallation } from "@/chat/slack/adapter-context";

export interface JuniorRuntimeServices {
  conversationMemory: ConversationMemoryService;
  contextCompactor: ContextCompactor;
  replyExecutor: ReplyExecutorServices;
  subscribedReplyPolicy: SubscribedReplyPolicy;
  visionContext: VisionContextService;
}

export interface JuniorRuntimeServiceOverrides {
  conversationMemory?: Partial<ConversationMemoryDeps>;
  contextCompactor?: Partial<ContextCompactorDeps>;
  replyExecutor?: Partial<Omit<ReplyExecutorServices, "generateThreadTitle">>;
  subscribedReplyPolicy?: Partial<SubscribedReplyPolicyDeps>;
  sandbox?: {
    tracePropagation?: SandboxEgressTracePropagationConfig;
  };
  visionContext?: Partial<VisionContextDeps>;
}

/** Bind recoverable provider calls to the persisted destination installation. */
export function createInstallationBoundRecoverableSlackDeliveryPort(args: {
  getSlackAdapter: () => SlackAdapter;
}): RecoverableSlackDeliveryPort {
  return {
    post: async ({ teamId, ...input }) =>
      await runWithSlackInstallation({
        adapter: args.getSlackAdapter(),
        installation: { teamId },
        task: async () => await postRecoverableSlackMessage(input),
      }),
    reconcile: async ({ teamId, ...input }) =>
      await runWithSlackInstallation({
        adapter: args.getSlackAdapter(),
        installation: { teamId },
        task: async () => await reconcileRecoverableSlackMessage(input),
      }),
  };
}

/** Compose the production SQL and Slack ports for durable reply delivery. */
export function createProductionRecoverableSlackDelivery(args: {
  getSlackAdapter: () => SlackAdapter;
}): RecoverableSlackDelivery {
  return new RecoverableSlackDeliveryService(
    getSqlExecutor(),
    createInstallationBoundRecoverableSlackDeliveryPort(args),
  );
}

export function createJuniorRuntimeServices(
  options: { getSlackAdapter: () => SlackAdapter },
  overrides: JuniorRuntimeServiceOverrides = {},
): JuniorRuntimeServices {
  const conversationMemory = createConversationMemoryService({
    completeText: overrides.conversationMemory?.completeText ?? completeText,
  });
  const contextCompactor = createContextCompactor({
    completeText: overrides.contextCompactor?.completeText ?? completeText,
    autoCompactionTriggerTokens:
      overrides.contextCompactor?.autoCompactionTriggerTokens,
  });
  const visionContext = createVisionContextService({
    completeText: overrides.visionContext?.completeText ?? completeText,
    listThreadReplies:
      overrides.visionContext?.listThreadReplies ?? listThreadReplies,
    downloadFile:
      overrides.visionContext?.downloadFile ?? downloadPrivateSlackFile,
  });

  return {
    conversationMemory,
    contextCompactor,
    replyExecutor: {
      contextCompactor:
        overrides.replyExecutor?.contextCompactor ?? contextCompactor,
      agentRunner:
        overrides.replyExecutor?.agentRunner ??
        createAgentRunner(executeAgentRunImpl, {
          tracePropagation: overrides.sandbox?.tracePropagation,
        }),
      getAwaitingAgentContinueRequest:
        overrides.replyExecutor?.getAwaitingAgentContinueRequest ??
        getAwaitingAgentContinueRequest,
      lookupSlackUser:
        overrides.replyExecutor?.lookupSlackUser ?? lookupSlackUser,
      scheduleAgentContinue:
        overrides.replyExecutor?.scheduleAgentContinue ?? scheduleAgentContinue,
      scheduleSessionCompletedPluginTasks:
        overrides.replyExecutor?.scheduleSessionCompletedPluginTasks ??
        (async (params) => {
          await scheduleSessionCompletedPluginTasks(params);
        }),
      recoverableSlackDelivery:
        overrides.replyExecutor?.recoverableSlackDelivery ??
        createProductionRecoverableSlackDelivery(options),
      turnLifecycle:
        overrides.replyExecutor?.turnLifecycle ??
        new ConversationTurnLifecycleService(getConversationEventStore()),
      generateThreadTitle: conversationMemory.generateThreadTitle,
    },
    subscribedReplyPolicy: createSubscribedReplyPolicy({
      completeObject:
        overrides.subscribedReplyPolicy?.completeObject ?? completeObject,
    }),
    visionContext,
  };
}
