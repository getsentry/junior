import { randomUUID } from "node:crypto";
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
import { getConversationStore } from "@/chat/db";
import { hasAgentTurnUsage, type AgentTurnUsage } from "@/chat/usage";
import { persistWithRetry } from "@/chat/services/persist-retry";

function usageConversationId(
  metadata: Record<string, unknown> | undefined,
): string | undefined {
  const conversationId = metadata?.conversationId;
  return typeof conversationId === "string" && conversationId.trim()
    ? conversationId
    : undefined;
}

async function recordUsage(args: {
  conversationId: string;
  id: string;
  usage: AgentTurnUsage | undefined;
}): Promise<void> {
  const usage = args.usage;
  if (!hasAgentTurnUsage(usage)) {
    return;
  }
  await persistWithRetry(async () => {
    await getConversationStore().recordUsage({
      conversationId: args.conversationId,
      id: args.id,
      usage,
    });
  });
}

function withTextUsage(base: typeof completeText): typeof completeText {
  return async (params) => {
    const id = randomUUID();
    const result = await base(params);
    const conversationId = usageConversationId(params.metadata);
    if (conversationId) {
      await recordUsage({ conversationId, id, usage: result.usage });
    }
    return result;
  };
}

function withObjectUsage(base: typeof completeObject): typeof completeObject {
  return async (params) => {
    const id = randomUUID();
    const result = await base(params);
    const conversationId = usageConversationId(params.metadata);
    if (conversationId) {
      await recordUsage({ conversationId, id, usage: result.usage });
    }
    return result;
  };
}

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

export function createJuniorRuntimeServices(
  overrides: JuniorRuntimeServiceOverrides = {},
): JuniorRuntimeServices {
  const textCompletion = withTextUsage(completeText);
  const conversationMemory = createConversationMemoryService({
    completeText:
      overrides.conversationMemory?.completeText === undefined
        ? textCompletion
        : withTextUsage(overrides.conversationMemory.completeText),
  });
  const contextCompactor = createContextCompactor({
    completeText:
      overrides.contextCompactor?.completeText === undefined
        ? textCompletion
        : withTextUsage(overrides.contextCompactor.completeText),
    autoCompactionTriggerTokens:
      overrides.contextCompactor?.autoCompactionTriggerTokens,
  });
  const visionContext = createVisionContextService({
    completeText:
      overrides.visionContext?.completeText === undefined
        ? textCompletion
        : withTextUsage(overrides.visionContext.completeText),
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
      generateThreadTitle: conversationMemory.generateThreadTitle,
    },
    subscribedReplyPolicy: createSubscribedReplyPolicy({
      completeObject: withObjectUsage(
        overrides.subscribedReplyPolicy?.completeObject ?? completeObject,
      ),
    }),
    visionContext,
  };
}
