import { completeObject, completeText } from "@/chat/pi/client";
import { generateAssistantReply as generateAssistantReplyImpl } from "@/chat/respond";
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

  return {
    conversationMemory,
    contextCompactor,
    replyExecutor: {
      contextCompactor:
        overrides.replyExecutor?.contextCompactor ?? contextCompactor,
      generateAssistantReply:
        overrides.replyExecutor?.generateAssistantReply ??
        generateAssistantReplyImpl,
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
