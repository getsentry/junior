/**
 * Model-profile handoff helpers for one agent run slice.
 *
 * Owns the durable handoff commit, Pi apply shape, tool control, and the few
 * loop checks that only care about handoff tool calls.
 */
import {
  type Agent,
  type AgentLoopTurnUpdate,
  type AgentTool,
} from "@earendil-works/pi-agent-core";
import type { ResumeState } from "@/chat/agent/resume";
import { botConfig } from "@/chat/config";
import {
  extractGenAiUsageSummary,
  logWarn,
  setSpanAttributes,
} from "@/chat/logging";
import { profileConfig, type ModelProfile } from "@/chat/model-profile";
import { completeText, resolveGatewayModel } from "@/chat/pi/client";
import type { PiMessage } from "@/chat/pi/messages";
import {
  isAssistantMessage,
  retainRuntimeTurnContext,
} from "@/chat/pi/transcript";
import {
  compactContextForHandoff,
  type CompactContextArgs,
} from "@/chat/services/context-compaction";
import {
  toPiReasoningLevel,
  type TurnRoute,
} from "@/chat/services/turn-router";
import {
  createHandoffTool,
  HANDOFF_TOOL_NAME,
} from "@/chat/tools/handoff/tool";
import type { ToolRuntimeContext } from "@/chat/tools/types";
import { hasAgentTurnUsage, type AgentTurnUsage } from "@/chat/usage";

/** Staged handoff waiting for the next Pi turn boundary. */
export type PendingHandoff = {
  messages: PiMessage[];
  model: ReturnType<typeof resolveGatewayModel>;
  modelId: string;
  modelProfile: ModelProfile;
  phaseUsage?: AgentTurnUsage;
  thinkingLevel: NonNullable<AgentLoopTurnUpdate["thinkingLevel"]>;
  turnRoute: TurnRoute;
};

/** Tools that must be the only tool call in their assistant message. */
const EXCLUSIVE_TOOL_NAMES = [HANDOFF_TOOL_NAME, "switchWorkspace"] as const;

/** Return the exclusive tool name when one is present among the calls. */
export function exclusiveToolName(
  toolCalls: ReadonlyArray<{ name: string }>,
): string | undefined {
  for (const name of EXCLUSIVE_TOOL_NAMES) {
    if (toolCalls.some((call) => call.name === name)) {
      return name;
    }
  }
  return undefined;
}

/** Build the tool control for every configured profile except the active one. */
export function handoffControl(args: {
  activeProfile: ModelProfile;
  enabled: boolean;
  execute: NonNullable<ToolRuntimeContext["handoff"]>["execute"];
}): ToolRuntimeContext["handoff"] {
  if (!args.enabled) {
    return undefined;
  }
  const profileNames = [
    botConfig.defaultProfile,
    ...Object.keys(botConfig.profiles)
      .filter((profile) => profile !== botConfig.defaultProfile)
      .sort(),
  ].filter((profile) => profile !== args.activeProfile);
  const [firstProfileName, ...otherProfileNames] = profileNames;
  if (!firstProfileName) {
    return undefined;
  }
  const toHandoffProfile = (name: ModelProfile) => ({
    name,
    description: profileConfig(botConfig, name).description,
  });
  return {
    profiles: [
      toHandoffProfile(firstProfileName),
      ...otherProfileNames.map(toHandoffProfile),
    ] as const,
    execute: args.execute,
  };
}

/**
 * Rebind the handoff tool description and schema for the active profile.
 * Other tools stay as wired.
 */
export function toolsForHandoffProfile(args: {
  activeProfile: ModelProfile;
  agentTools: AgentTool[];
  enabled: boolean;
  execute: NonNullable<ToolRuntimeContext["handoff"]>["execute"];
}): AgentTool[] {
  const control = handoffControl({
    activeProfile: args.activeProfile,
    enabled: args.enabled,
    execute: args.execute,
  });
  if (!control) {
    return args.agentTools.filter((tool) => tool.name !== HANDOFF_TOOL_NAME);
  }
  const handoffAgentTool = args.agentTools.find(
    (tool) => tool.name === HANDOFF_TOOL_NAME,
  );
  if (!handoffAgentTool) {
    throw new Error("Handoff control is missing its Pi tool");
  }
  const definition = createHandoffTool(control);
  return args.agentTools.map((tool) =>
    tool.name === HANDOFF_TOOL_NAME
      ? ({
          ...handoffAgentTool,
          description: definition.description,
          parameters: definition.inputSchema,
          prepareArguments: definition.prepareArguments,
        } as AgentTool)
      : tool,
  );
}

/**
 * Commit the durable handoff epoch and return the staged Pi swap.
 * No-op when the requested profile is already active.
 */
export async function commitHandoff(args: {
  activeModelProfile: ModelProfile;
  beforeMessageCount: number;
  conversationContext?: string;
  conversationId: string;
  metadata?: CompactContextArgs["metadata"];
  onStatus?: (status: { text: string }) => void | Promise<void>;
  profile: ModelProfile;
  runtimeContextSourceMessages?: PiMessage[];
  signal?: AbortSignal;
  sourceMessages: PiMessage[];
  triggeringToolCallId?: string;
  turnRoute: TurnRoute;
}): Promise<PendingHandoff | undefined> {
  if (args.profile === args.activeModelProfile) {
    return undefined;
  }
  const runtimeContext = retainRuntimeTurnContext(
    args.runtimeContextSourceMessages ?? args.sourceMessages,
  );
  const phaseUsageSummary = extractGenAiUsageSummary(
    ...args.sourceMessages
      .slice(args.beforeMessageCount)
      .filter(isAssistantMessage),
  );
  const phaseUsage = hasAgentTurnUsage(phaseUsageSummary)
    ? phaseUsageSummary
    : undefined;
  const selectedProfile = profileConfig(botConfig, args.profile);
  const handoffReasoningLevel =
    selectedProfile.reasoningLevel ?? args.turnRoute.reasoningLevel;
  const target = {
    modelId: selectedProfile.modelId,
    modelProfile: args.profile,
    reasoningLevel: handoffReasoningLevel,
  };
  void (async () => {
    await args.onStatus?.({ text: "Switching models" });
  })().catch((error) => {
    logWarn("assistant.status.observer.failed", {
      "exception.message":
        error instanceof Error ? error.message : String(error),
    });
  });
  const handoffMessages = await compactContextForHandoff(
    {
      conversationContext: args.conversationContext,
      conversationId: args.conversationId,
      piMessages: args.sourceMessages,
      runtimeContext,
      signal: args.signal,
      triggeringToolCallId: args.triggeringToolCallId,
      target,
      metadata: args.metadata,
    },
    {
      completeText: (completeArgs) => completeText(completeArgs),
    },
  );
  const turnRoute =
    handoffReasoningLevel === args.turnRoute.reasoningLevel
      ? args.turnRoute
      : {
          ...args.turnRoute,
          reasoningLevel: handoffReasoningLevel,
          reason: `profile_reasoning_override:${args.profile}:${args.turnRoute.reason}`,
        };
  return {
    messages: handoffMessages,
    model: resolveGatewayModel(target.modelId),
    modelId: target.modelId,
    modelProfile: args.profile,
    phaseUsage,
    thinkingLevel: toPiReasoningLevel(handoffReasoningLevel),
    turnRoute,
  };
}

/** Apply a committed handoff to Pi and reset its durable resume baseline. */
export function applyHandoff(args: {
  agent: Agent;
  baseInstructions: string;
  pending: PendingHandoff;
  resume: ResumeState;
  tools: AgentTool[];
}): AgentLoopTurnUpdate {
  const replacement = [...args.pending.messages];
  args.agent.state.messages = replacement;
  args.agent.state.model = args.pending.model;
  args.agent.state.thinkingLevel = args.pending.thinkingLevel;
  args.agent.state.tools = args.tools;
  args.resume.setBeforeMessageCount(replacement.length);
  args.resume.setTurnStartMessageIndex(0);
  args.resume.adoptCommittedBoundary(replacement);
  setSpanAttributes({
    "gen_ai.agent.model": args.pending.modelId,
    "gen_ai.agent.model_profile": args.pending.modelProfile,
    "gen_ai.agent.reasoning.level": args.pending.turnRoute.reasoningLevel,
  });
  return {
    context: {
      systemPrompt: args.baseInstructions,
      messages: replacement,
      tools: args.tools,
    },
    model: args.pending.model,
    thinkingLevel: args.pending.thinkingLevel,
  };
}
