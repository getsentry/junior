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

/** Scenario adapters for deterministic runtime tests and evals. */
export interface JuniorRuntimeScenarioAdapters {
  autoCompactionTriggerTokens?: ContextCompactorDeps["autoCompactionTriggerTokens"];
  classifySubscribedReply?: SubscribedReplyPolicyDeps["completeObject"];
  compactConversationText?: ContextCompactorDeps["completeText"];
  describeImagesText?: VisionContextDeps["completeText"];
  downloadSlackFile?: VisionContextDeps["downloadFile"];
  generateAssistantReply?: ReplyExecutorServices["generateAssistantReply"];
  generateThreadTitleText?: ConversationMemoryDeps["completeText"];
  getAwaitingAgentContinueRequest?: ReplyExecutorServices["getAwaitingAgentContinueRequest"];
  listThreadReplies?: VisionContextDeps["listThreadReplies"];
  lookupSlackUser?: ReplyExecutorServices["lookupSlackUser"];
  sandboxTracePropagation?: SandboxEgressTracePropagationConfig;
  scheduleAgentContinue?: ReplyExecutorServices["scheduleAgentContinue"];
}

/** Apply app-owned sandbox egress trace config unless a turn overrides it. */
export function withSandboxTracePropagation(
  generateReply: typeof generateAssistantReplyImpl,
  tracePropagation?: SandboxEgressTracePropagationConfig,
): typeof generateAssistantReplyImpl {
  return async (messageText: string, context: ReplyRequestContext) =>
    await generateReply(messageText, {
      ...context,
      sandbox: {
        ...context.sandbox,
        tracePropagation: context.sandbox?.tracePropagation ?? tracePropagation,
      },
    });
}

/** Compose the concrete service set used by the Slack runtime. */
export function createJuniorRuntimeServices(
  adapters: JuniorRuntimeScenarioAdapters = {},
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
        adapters.generateAssistantReply ??
        withSandboxTracePropagation(
          generateAssistantReplyImpl,
          adapters.sandboxTracePropagation,
        ),
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
