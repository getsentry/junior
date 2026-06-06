import { completeObject, completeText } from "@/chat/pi/client";
import {
  generateAssistantReply as generateAssistantReplyImpl,
  type AssistantReplyRequestContext,
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

/** Scenario adapters for runtime tests and evals that need deterministic external boundaries. */
export interface JuniorRuntimeAdapterOverrides {
  compactConversationText?: ContextCompactorDeps["completeText"];
  describeImagesText?: VisionContextDeps["completeText"];
  downloadSlackFile?: VisionContextDeps["downloadFile"];
  generateAssistantReply?: ReplyExecutorServices["generateAssistantReply"];
  generateThreadTitleText?: ConversationMemoryDeps["completeText"];
  getAwaitingAgentContinueRequest?: ReplyExecutorServices["getAwaitingAgentContinueRequest"];
  listThreadReplies?: VisionContextDeps["listThreadReplies"];
  lookupSlackUser?: ReplyExecutorServices["lookupSlackUser"];
  scheduleAgentContinue?: ReplyExecutorServices["scheduleAgentContinue"];
  classifySubscribedReply?: SubscribedReplyPolicyDeps["completeObject"];
  autoCompactionTriggerTokens?: ContextCompactorDeps["autoCompactionTriggerTokens"];
}

/** Compose the concrete service set used by the Slack runtime. */
export function createJuniorRuntimeServices(
  adapters: JuniorRuntimeAdapterOverrides = {},
): JuniorRuntimeServices {
  const conversationMemory = createConversationMemoryService({
    completeText: adapters.generateThreadTitleText ?? completeText,
  });
  const contextCompactor = createContextCompactor({
    completeText: adapters.compactConversationText ?? completeText,
    autoCompactionTriggerTokens: adapters.autoCompactionTriggerTokens,
  });
  const visionContext = createVisionContextService({
    completeText: adapters.describeImagesText ?? completeText,
    listThreadReplies: adapters.listThreadReplies ?? listThreadReplies,
    downloadFile: adapters.downloadSlackFile ?? downloadPrivateSlackFile,
  });

  return {
    conversationMemory,
    contextCompactor,
    replyExecutor: {
      contextCompactor,
      generateAssistantReply:
        adapters.generateAssistantReply ?? generateAssistantReplyImpl,
      getAwaitingAgentContinueRequest:
        adapters.getAwaitingAgentContinueRequest ??
        getAwaitingAgentContinueRequest,
      lookupSlackUser: adapters.lookupSlackUser ?? lookupSlackUser,
      scheduleAgentContinue:
        adapters.scheduleAgentContinue ?? scheduleAgentContinue,
      generateThreadTitle: conversationMemory.generateThreadTitle,
    },
    subscribedReplyPolicy: createSubscribedReplyPolicy({
      completeObject: adapters.classifySubscribedReply ?? completeObject,
    }),
    visionContext,
  };
}
