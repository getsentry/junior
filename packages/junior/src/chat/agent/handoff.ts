/**
 * Model-profile handoff for one agent run slice.
 *
 * Owns pending handoff state, tool control, Pi tool rebinding after a swap,
 * and the one-way model/context apply at Pi's turn boundary.
 */
import {
  type Agent,
  type AgentLoopTurnUpdate,
  type AgentTool,
} from "@earendil-works/pi-agent-core";
import { botConfig } from "@/chat/config";
import {
  extractGenAiUsageSummary,
  logWarn,
  setSpanAttributes,
} from "@/chat/logging";
import { completeText, resolveGatewayModel } from "@/chat/pi/client";
import type { PiMessage } from "@/chat/pi/messages";
import {
  isAssistantMessage,
  retainRuntimeTurnContext,
} from "@/chat/pi/transcript";
import type { ResumeState } from "@/chat/agent/resume";
import { profileConfig, type ModelProfile } from "@/chat/model-profile";
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
import {
  addAgentTurnUsage,
  hasAgentTurnUsage,
  type AgentTurnUsage,
} from "@/chat/usage";

type HandoffControl = NonNullable<ToolRuntimeContext["handoff"]>;

type PendingHandoff = {
  messages: PiMessage[];
  model: ReturnType<typeof resolveGatewayModel>;
  thinkingLevel: NonNullable<AgentLoopTurnUpdate["thinkingLevel"]>;
};

export type ModelHandoffOptions = {
  conversationContext?: string;
  conversationId: string;
  enabled: boolean;
  getActiveModelId: () => string;
  getActiveModelProfile: () => ModelProfile;
  getAgent: () => Agent | undefined;
  getBaseInstructions: () => string;
  getPriorPhaseUsage: () => AgentTurnUsage | undefined;
  getTurnRoute: () => TurnRoute;
  metadata?: CompactContextArgs["metadata"];
  onStatus?: (args: { text: string }) => void | Promise<void>;
  resume: ResumeState;
  setActiveModel: (args: {
    modelId: string;
    modelProfile: ModelProfile;
  }) => void;
  setPriorPhaseUsage: (usage: AgentTurnUsage | undefined) => void;
  setTurnRoute: (route: TurnRoute) => void;
  usageBoundaryMessageCount: () => number;
};

/** Create the handoff controller for one agent run slice. */
export function createModelHandoff(options: ModelHandoffOptions) {
  let pendingHandoff: PendingHandoff | undefined;
  let agentTools: AgentTool[] = [];
  let toolsWithoutHandoff: AgentTool[] = [];
  let handoffAgentTool: AgentTool | undefined;
  const handoffProfiles: [ModelProfile, ...ModelProfile[]] = [
    botConfig.defaultProfile,
    ...Object.keys(botConfig.profiles)
      .filter((profile) => profile !== botConfig.defaultProfile)
      .sort(),
  ];

  const usageSinceCurrentBoundary = (
    messages: PiMessage[],
  ): AgentTurnUsage | undefined => {
    const usage = extractGenAiUsageSummary(
      ...messages
        .slice(options.usageBoundaryMessageCount())
        .filter(isAssistantMessage),
    );
    return hasAgentTurnUsage(usage) ? usage : undefined;
  };

  /** Commit the durable handoff epoch before staging its in-memory model swap. */
  const schedule = async (args: {
    profile: ModelProfile;
    runtimeContextSourceMessages?: PiMessage[];
    signal?: AbortSignal;
    sourceMessages: PiMessage[];
    triggeringToolCallId?: string;
  }) => {
    if (args.profile === options.getActiveModelProfile()) {
      return;
    }
    const runtimeContext = retainRuntimeTurnContext(
      args.runtimeContextSourceMessages ?? args.sourceMessages,
    );
    const phaseUsage = usageSinceCurrentBoundary(args.sourceMessages);
    const selectedProfile = profileConfig(botConfig, args.profile);
    const turnRoute = options.getTurnRoute();
    const handoffReasoningLevel =
      selectedProfile.reasoningLevel ?? turnRoute.reasoningLevel;
    const target = {
      modelId: selectedProfile.modelId,
      modelProfile: args.profile,
      reasoningLevel: handoffReasoningLevel,
    };
    const handoffModel = resolveGatewayModel(target.modelId);
    const handoffThinkingLevel = toPiReasoningLevel(handoffReasoningLevel);
    void (async () => {
      await options.onStatus?.({ text: "Switching models" });
    })().catch((error) => {
      logWarn("assistant.status.observer.failed", {
        "exception.message":
          error instanceof Error ? error.message : String(error),
      });
    });
    const handoffMessages = await compactContextForHandoff(
      {
        conversationContext: options.conversationContext,
        conversationId: options.conversationId,
        piMessages: args.sourceMessages,
        runtimeContext,
        signal: args.signal,
        triggeringToolCallId: args.triggeringToolCallId,
        target,
        metadata: options.metadata,
      },
      {
        completeText: (args) => completeText(args),
      },
    );
    if (handoffReasoningLevel !== turnRoute.reasoningLevel) {
      options.setTurnRoute({
        ...turnRoute,
        reasoningLevel: handoffReasoningLevel,
        reason: `profile_reasoning_override:${args.profile}:${turnRoute.reason}`,
      });
    }
    options.setPriorPhaseUsage(
      addAgentTurnUsage(options.getPriorPhaseUsage(), phaseUsage),
    );
    pendingHandoff = {
      messages: handoffMessages,
      model: handoffModel,
      thinkingLevel: handoffThinkingLevel,
    };
    options.setActiveModel({
      modelId: target.modelId,
      modelProfile: args.profile,
    });
  };

  const controlFor = (
    activeProfile: ModelProfile,
  ): HandoffControl | undefined => {
    const profileNames = handoffProfiles.filter(
      (profile) => profile !== activeProfile,
    );
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
      execute: async (
        profile: ModelProfile,
        executeOptions: { signal?: AbortSignal; toolCallId: string },
      ) =>
        await schedule({
          profile,
          signal: executeOptions.signal,
          sourceMessages: [...options.getAgent()!.state.messages],
          triggeringToolCallId: executeOptions.toolCallId,
        }),
    };
  };

  const toolsForActiveProfile = (): AgentTool[] => {
    if (!options.enabled) {
      return toolsWithoutHandoff;
    }
    const handoff = controlFor(options.getActiveModelProfile());
    if (!handoff) {
      return toolsWithoutHandoff;
    }
    if (!handoffAgentTool) {
      throw new Error("Handoff control is missing its Pi tool");
    }
    const definition = createHandoffTool(handoff);
    return agentTools.map((tool) =>
      tool.name === HANDOFF_TOOL_NAME
        ? ({
            ...handoffAgentTool,
            description: definition.description,
            parameters: definition.inputSchema,
            prepareArguments: definition.prepareArguments,
          } as AgentTool)
        : tool,
    );
  };

  /** Apply a committed handoff to Pi and reset its durable resume baseline. */
  const applyPending = (): AgentLoopTurnUpdate | undefined => {
    if (!pendingHandoff) {
      return undefined;
    }
    const agent = options.getAgent();
    if (!agent) {
      throw new Error("Handoff requires an active agent");
    }
    const { messages, model, thinkingLevel } = pendingHandoff;
    const replacement = [...messages];
    pendingHandoff = undefined;
    agent.state.messages = replacement;
    agent.state.model = model;
    agent.state.thinkingLevel = thinkingLevel;
    const tools = toolsForActiveProfile();
    agent.state.tools = tools;
    options.resume.setBeforeMessageCount(replacement.length);
    options.resume.setTurnStartMessageIndex(0);
    options.resume.adoptCommittedBoundary(replacement);
    setSpanAttributes({
      "gen_ai.agent.model": options.getActiveModelId(),
      "gen_ai.agent.model_profile": options.getActiveModelProfile(),
      "gen_ai.agent.reasoning.level": options.getTurnRoute().reasoningLevel,
    });
    return {
      context: {
        systemPrompt: options.getBaseInstructions(),
        messages: replacement,
        tools,
      },
      model,
      thinkingLevel,
    };
  };

  return {
    applyPending,
    bindAgentTools(tools: AgentTool[]) {
      agentTools = tools;
      toolsWithoutHandoff = tools.filter(
        (tool) => tool.name !== HANDOFF_TOOL_NAME,
      );
      handoffAgentTool = tools.find((tool) => tool.name === HANDOFF_TOOL_NAME);
    },
    get hasPending() {
      return Boolean(pendingHandoff);
    },
    initialControl: options.enabled
      ? controlFor(options.getActiveModelProfile())
      : undefined,
    schedule,
  };
}

export type ModelHandoff = ReturnType<typeof createModelHandoff>;
