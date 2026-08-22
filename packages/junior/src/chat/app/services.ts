import { completeObject, completeText } from "@/chat/pi/client";
import { executeAgentRun as executeAgentRunImpl } from "@/chat/agent";
import type { SandboxEgressTracePropagationConfig } from "@/chat/sandbox/egress/tracing";
import {
  getPausedTurnRequest,
  wakePausedTurn,
} from "@/chat/task-execution/turn-wake";
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
import { ConversationTurnLifecycleService } from "@/chat/conversations/turn-lifecycle";
import { getConversationEventStore } from "@/chat/db";
import { bindSpawnAgent } from "@/chat/agent-invocations/spawn";
import { getVercelConversationWorkQueue } from "@/chat/task-execution/vercel-queue";

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
  replyExecutor?: Partial<ReplyExecutorServices>;
  subscribedReplyPolicy?: Partial<SubscribedReplyPolicyDeps>;
  sandbox?: {
    tracePropagation?: SandboxEgressTracePropagationConfig;
  };
  visionContext?: Partial<VisionContextDeps>;
}

export function createJuniorRuntimeServices(
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
  const agentRunner =
    overrides.replyExecutor?.agentRunner ??
    createAgentRunner(executeAgentRunImpl, {
      bindSpawnAgent: (request) =>
        bindSpawnAgent(request, { queue: getVercelConversationWorkQueue }),
      tracePropagation: overrides.sandbox?.tracePropagation,
    });

  return {
    conversationMemory,
    contextCompactor,
    replyExecutor: {
      contextCompactor:
        overrides.replyExecutor?.contextCompactor ?? contextCompactor,
      agentRunner,
      getPausedTurnRequest:
        overrides.replyExecutor?.getPausedTurnRequest ?? getPausedTurnRequest,
      lookupSlackUser:
        overrides.replyExecutor?.lookupSlackUser ?? lookupSlackUser,
      wakePausedTurn: overrides.replyExecutor?.wakePausedTurn ?? wakePausedTurn,
      scheduleSessionCompletedPluginTasks:
        overrides.replyExecutor?.scheduleSessionCompletedPluginTasks ??
        (async (params) => {
          await scheduleSessionCompletedPluginTasks(params);
        }),
      turnLifecycle:
        overrides.replyExecutor?.turnLifecycle ??
        new ConversationTurnLifecycleService(getConversationEventStore()),
    },
    subscribedReplyPolicy: createSubscribedReplyPolicy({
      completeObject:
        overrides.subscribedReplyPolicy?.completeObject ?? completeObject,
    }),
    visionContext,
  };
}
