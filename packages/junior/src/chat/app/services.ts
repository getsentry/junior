import { completeDecision, completeText } from "@/chat/pi/client";
import { executeAgentRun as executeAgentRunImpl } from "@/chat/agent";
import type { SandboxEgressTracePropagationConfig } from "@/chat/sandbox/egress/tracing";
import {
  createConversationMemoryService,
  type ConversationMemoryDeps,
  type ConversationMemoryService,
} from "@/chat/services/conversation-memory";
import { downloadPrivateSlackFile } from "@/chat/slack/client";
import { listThreadReplies } from "@/chat/slack/channel";
import {
  createSubscribedReplyPolicy,
  type SubscribedReplyPolicy,
  type SubscribedReplyPolicyDeps,
} from "@/chat/services/subscribed-reply-policy";
import {
  createVisionContextService,
  type VisionContextDeps,
  type VisionContextService,
} from "@/chat/slack/vision-context";
import {
  createAgentRunner,
  type AgentRunner,
} from "@/chat/runtime/agent-runner";
import { executeTurn, type ExecuteTurn } from "@/chat/runtime/turn-execution";
import { bindMessageAgent } from "@/chat/agent-invocations/message";
import { bindSpawnAgent } from "@/chat/agent-invocations/spawn";
import { getVercelConversationWorkQueue } from "@/chat/task-execution/vercel-queue";

export interface JuniorRuntimeServices {
  conversationMemory: ConversationMemoryService;
  executeTurn: ExecuteTurn;
  subscribedReplyPolicy: SubscribedReplyPolicy;
  visionContext: VisionContextService;
}

export interface JuniorRuntimeServiceOverrides {
  agentRunner?: AgentRunner;
  conversationMemory?: Partial<ConversationMemoryDeps>;
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
  const visionContext = createVisionContextService({
    attachmentStorage: overrides.visionContext?.attachmentStorage,
    completeText: overrides.visionContext?.completeText ?? completeText,
    listThreadReplies:
      overrides.visionContext?.listThreadReplies ?? listThreadReplies,
    downloadFile:
      overrides.visionContext?.downloadFile ?? downloadPrivateSlackFile,
  });
  const agentRunner =
    overrides.agentRunner ??
    createAgentRunner(executeAgentRunImpl, {
      bindMessageAgent: (request) =>
        bindMessageAgent(request, { queue: getVercelConversationWorkQueue }),
      bindSpawnAgent: (request) =>
        bindSpawnAgent(request, { queue: getVercelConversationWorkQueue }),
      tracePropagation: overrides.sandbox?.tracePropagation,
    });

  return {
    conversationMemory,
    executeTurn: async (run, saveResult) =>
      await executeTurn(agentRunner, run, saveResult),
    subscribedReplyPolicy: createSubscribedReplyPolicy({
      completeDecision:
        overrides.subscribedReplyPolicy?.completeDecision ?? completeDecision,
    }),
    visionContext,
  };
}
