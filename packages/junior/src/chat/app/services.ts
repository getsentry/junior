import { completeObject, completeText } from "@/chat/pi/client";
import { generateAssistantReply as generateAssistantReplyImpl } from "@/chat/respond";
import { scheduleTurnTimeoutResume } from "@/chat/services/timeout-resume";
import {
  createConversationMemoryService,
  type ConversationMemoryDeps,
  type ConversationMemoryService,
} from "@/chat/services/conversation-memory";
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
  replyExecutor: ReplyExecutorServices;
  subscribedReplyPolicy: SubscribedReplyPolicy;
  visionContext: VisionContextService;
}

export interface JuniorRuntimeServiceOverrides {
  conversationMemory?: Partial<ConversationMemoryDeps>;
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
  const visionContext = createVisionContextService({
    completeText: overrides.visionContext?.completeText ?? completeText,
    listThreadReplies:
      overrides.visionContext?.listThreadReplies ?? listThreadReplies,
    downloadPrivateSlackFile:
      overrides.visionContext?.downloadPrivateSlackFile ??
      downloadPrivateSlackFile,
  });

  return {
    conversationMemory,
    replyExecutor: {
      generateAssistantReply:
        overrides.replyExecutor?.generateAssistantReply ??
        generateAssistantReplyImpl,
      lookupSlackUser:
        overrides.replyExecutor?.lookupSlackUser ?? lookupSlackUser,
      scheduleTurnTimeoutResume:
        overrides.replyExecutor?.scheduleTurnTimeoutResume ??
        scheduleTurnTimeoutResume,
      generateThreadTitle: conversationMemory.generateThreadTitle,
    },
    subscribedReplyPolicy: createSubscribedReplyPolicy({
      completeObject:
        overrides.subscribedReplyPolicy?.completeObject ?? completeObject,
    }),
    visionContext,
  };
}
