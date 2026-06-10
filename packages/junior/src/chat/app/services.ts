import { completeObject, completeText } from "@/chat/pi/client";
import {
  generateAssistantReply as generateAssistantReplyImpl,
  type ReplyRequestContext,
} from "@/chat/respond";
import type { SandboxEgressTracePropagationConfig } from "@/chat/sandbox/egress-tracing";
import {
  getAwaitingAgentContinueRequest,
  scheduleAgentContinue,
} from "@/chat/services/agent-continue";
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
} from "@/chat/services/vision-context";

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

/** Apply app-owned sandbox egress trace config unless a turn overrides it. */
export function withSandboxTracePropagation(
  generateReply: typeof generateAssistantReplyImpl,
  tracePropagation?: SandboxEgressTracePropagationConfig,
): typeof generateAssistantReplyImpl {
  return async (messageText: string, context?: ReplyRequestContext) =>
    await generateReply(messageText, {
      ...context,
      sandbox: {
        ...context?.sandbox,
        tracePropagation:
          context?.sandbox?.tracePropagation ?? tracePropagation,
      },
    });
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

  return {
    conversationMemory,
    contextCompactor,
    replyExecutor: {
      contextCompactor:
        overrides.replyExecutor?.contextCompactor ?? contextCompactor,
      generateAssistantReply:
        overrides.replyExecutor?.generateAssistantReply ??
        withSandboxTracePropagation(
          generateAssistantReplyImpl,
          overrides.sandbox?.tracePropagation,
        ),
      getAwaitingAgentContinueRequest:
        overrides.replyExecutor?.getAwaitingAgentContinueRequest ??
        getAwaitingAgentContinueRequest,
      lookupSlackUser:
        overrides.replyExecutor?.lookupSlackUser ?? lookupSlackUser,
      scheduleAgentContinue:
        overrides.replyExecutor?.scheduleAgentContinue ?? scheduleAgentContinue,
      generateThreadTitle: conversationMemory.generateThreadTitle,
    },
    subscribedReplyPolicy: createSubscribedReplyPolicy({
      completeObject:
        overrides.subscribedReplyPolicy?.completeObject ?? completeObject,
    }),
    visionContext,
  };
}
