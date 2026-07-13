/**
 * Materializes immutable conversation execution defaults before delegating to
 * the agent kernel. Caller authority remains intact: profile tools only narrow
 * host restrictions, while durable model and reasoning choices own continuity.
 */
import type { AgentRunRequest } from "@/chat/agent/request";
import { assertCorrelationDestinationMatch } from "@/chat/agent/request";
import type {
  ConversationExecutionProfile,
  ConversationExecutionProfileStore,
  ConversationToolPolicy,
} from "@/chat/conversations/execution-profile";
import type { AgentRunner } from "@/chat/runtime/agent-runner";
import { parseSlackThreadId } from "@/chat/slack/context";

/** Dependencies for durable conversation execution-profile materialization. */
export interface ConversationRuntimeOptions {
  agentRunner: AgentRunner;
  defaultProfile: ConversationExecutionProfile;
  profileStore: ConversationExecutionProfileStore;
}

/** Intersect durable tool policy with the caller's host-owned restriction. */
function restrictToolPolicy(
  hostPolicy: ConversationToolPolicy | undefined,
  profilePolicy: ConversationToolPolicy,
): ConversationToolPolicy {
  if (hostPolicy?.mode !== "allowlist") {
    return profilePolicy;
  }
  if (profilePolicy.mode === "host") {
    return hostPolicy;
  }
  return {
    mode: "allowlist",
    toolNames: hostPolicy.toolNames.filter((name) =>
      profilePolicy.toolNames.includes(name),
    ),
  };
}

/** Require one canonical conversation identity across routing coordinates. */
function conversationIdForProfile(request: AgentRunRequest): string {
  const { correlation, destination, source } = request.routing;
  const conversationId = correlation?.conversationId;
  if (!conversationId) {
    throw new TypeError("Conversation runtime requires a conversationId");
  }
  if (destination.platform === "local") {
    if (
      source.platform !== "local" ||
      destination.conversationId !== conversationId ||
      source.conversationId !== conversationId
    ) {
      throw new TypeError("Local conversation routing identity does not match");
    }
    return conversationId;
  }
  if (source.platform !== "slack") {
    throw new TypeError("Slack conversation routing source does not match");
  }
  const thread = parseSlackThreadId(conversationId);
  const sourceThreadTs = source.threadTs ?? source.messageTs;
  if (
    !thread ||
    thread.channelId !== destination.channelId ||
    source.channelId !== destination.channelId ||
    source.teamId !== destination.teamId ||
    sourceThreadTs !== thread.threadTs ||
    (correlation.threadId !== undefined &&
      correlation.threadId !== conversationId)
  ) {
    throw new TypeError("Slack conversation routing identity does not match");
  }
  return conversationId;
}

/** Run agents from durable conversation behavior rather than caller defaults. */
export function createConversationRuntime(
  options: ConversationRuntimeOptions,
): AgentRunner {
  return {
    run: async (request: AgentRunRequest) => {
      assertCorrelationDestinationMatch(request.routing);
      const conversationId = conversationIdForProfile(request);
      const profile = await options.profileStore.getOrCreateExecutionProfile({
        conversationId,
        profile: options.defaultProfile,
      });
      return await options.agentRunner.run({
        ...request,
        policy: {
          ...request.policy,
          modelProfile: profile.modelProfile,
          reasoningPolicy: profile.reasoning,
          instructions: [
            ...(request.policy?.instructions ?? []),
            ...profile.instructions,
          ],
          toolPolicy: restrictToolPolicy(
            request.policy?.toolPolicy,
            profile.toolPolicy,
          ),
        },
      });
    },
  };
}
