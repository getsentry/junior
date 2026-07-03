import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Destination, Source } from "@sentry/junior-plugin-api";
import type { FileUpload } from "chat";
import { botConfig } from "@/chat/config";
import { listReferenceFiles } from "@/chat/discovery";
import { maybeExecuteJrRpcCustomCommand } from "@/chat/capabilities/jr-rpc-command";
import { createUserTokenStore } from "@/chat/capabilities/factory";
import { SkillSandbox } from "@/chat/sandbox/skill-sandbox";
import type { Skill, SkillInvocation, SkillMetadata } from "@/chat/skills";
import {
  createPluginHookRunner,
  type PluginHookRunner,
} from "@/chat/plugins/agent-hooks";
import { pluginCatalogRuntime } from "@/chat/plugins/catalog-runtime";
import { McpToolManager } from "@/chat/mcp/tool-manager";
import { inferActiveMcpProvidersFromPiMessages } from "@/chat/pi/derived-state";
import { createTools } from "@/chat/tools";
import type { ToolDefinition } from "@/chat/tools/definition";
import type { ToolRuntimeContext } from "@/chat/tools/types";
import { toActiveMcpCatalogSummaries } from "@/chat/tools/skill/mcp-tool-summary";
import { createAdvisorToolDefinitions } from "@/chat/tools/advisor/tool";
import { createAgentTools } from "@/chat/tools/agent-tools";
import {
  createSandboxExecutor,
  type SandboxExecutor,
} from "@/chat/sandbox/sandbox";
import { createLazySandboxWorkspace } from "@/chat/agent-run/sandbox-workspace";
import { createMcpAuthOrchestration } from "@/chat/services/mcp-auth-orchestration";
import { createPluginAuthOrchestration } from "@/chat/services/plugin-auth-orchestration";
import { createPluginEgress } from "@/chat/egress/plugin";
import { createTracedStreamFn } from "@/chat/pi/traced-stream";
import type { PiMessage } from "@/chat/pi/messages";
import type { LogContext } from "@/chat/logging";
import { logWarn, setTags } from "@/chat/logging";
import type { ConversationPrivacy } from "@/chat/conversation-privacy";
import { mergeArtifactsState } from "@/chat/runtime/thread-state";
import { upsertActiveSkill } from "@/chat/agent-run-helpers";
import type { Requester } from "@/chat/requester";
import type { ThreadArtifactsState } from "@/chat/state/artifacts";
import type {
  AgentRunDurability,
  AgentRunObservers,
  AgentRunPolicy,
  AgentRunRouting,
  AgentRunState,
} from "@/chat/agent-run/request";
import type { AgentTurnSurface } from "@/chat/state/turn-session";
import type { AuthorizationPauseError } from "@/chat/services/auth-pause";
import type { SliceCheckpointer } from "@/chat/agent-run/checkpointer";

interface ToolWiringArgs {
  abortAgent: () => void;
  activeSkills: Skill[];
  actorRequester?: Requester;
  artifactStatePatch: Partial<ThreadArtifactsState>;
  availableSkills: SkillMetadata[];
  checkpointer: SliceCheckpointer;
  configurationValues: Record<string, unknown>;
  connectedMcpProviders: Set<string>;
  conversationPrivacy?: ConversationPrivacy;
  deliveryFiles: FileUpload[];
  durability: AgentRunDurability;
  generatedFiles: FileUpload[];
  invokedSkill: SkillMetadata | null;
  observers: AgentRunObservers;
  onSandboxMetadataChanged: (sandbox: {
    sandboxId?: string;
    sandboxDependencyProfileHash?: string;
  }) => void;
  policy: AgentRunPolicy;
  preAgentPromptMessages: () => PiMessage[];
  priorPiMessages: PiMessage[] | undefined;
  recordConnectedMcpProvider: (provider: string) => Promise<void>;
  routing: AgentRunRouting;
  runSource: Source;
  sessionConversationId?: string;
  sessionId?: string;
  skillInvocation: SkillInvocation | null;
  skillSandbox: SkillSandbox;
  spanContext: LogContext;
  state: AgentRunState;
  surface?: AgentTurnSurface;
  syncLoadedSkillNamesForResume: () => void;
  toolCalls: string[];
  userInput: string;
}

export interface ToolWiring {
  activeMcpCatalogs: ReturnType<typeof toActiveMcpCatalogSummaries>;
  agentTools: AgentTool[];
  currentSandboxExecutor: SandboxExecutor;
  getPendingAuthPause: () => AuthorizationPauseError | undefined;
  mcpToolManager: McpToolManager;
  pluginHooks: PluginHookRunner;
  toolGuidance: Array<{
    name: string;
    promptGuidelines: ToolDefinition<any>["promptGuidelines"];
    promptSnippet: ToolDefinition<any>["promptSnippet"];
  }>;
  toolRuntimeContext: ToolRuntimeContext;
}

function toolInvocationDestination(routing: AgentRunRouting): Destination {
  if (routing.destination.platform !== "slack" || !routing.toolChannelId) {
    return routing.destination;
  }
  return {
    platform: "slack",
    teamId: routing.destination.teamId,
    channelId: routing.toolChannelId,
  };
}

/** Wires sandbox, auth orchestration, MCP restoration, and Pi tool surfaces for one run slice. */
export async function wireAgentTools(
  args: ToolWiringArgs,
): Promise<ToolWiring> {
  const authRequesterId =
    args.routing.credentialContext?.actor.type === "user"
      ? args.routing.credentialContext.actor.userId
      : undefined;
  const userTokenStore = createUserTokenStore();
  const pluginHooks = createPluginHookRunner({
    requester: args.actorRequester,
  });
  const sandboxExecutor = createSandboxExecutor({
    sandboxId: args.policy.sandbox?.sandboxId,
    sandboxDependencyProfileHash:
      args.policy.sandbox?.sandboxDependencyProfileHash,
    traceContext: args.spanContext,
    tracePropagation: args.policy.sandbox?.tracePropagation,
    credentialEgress: args.routing.credentialContext,
    agentHooks: pluginHooks,
    onSandboxAcquired: async (sandbox) => {
      args.onSandboxMetadataChanged({
        sandboxId: sandbox.sandboxId,
        sandboxDependencyProfileHash: sandbox.sandboxDependencyProfileHash,
      });
      await args.durability.onSandboxAcquired?.(sandbox);
    },
    runBashCustomCommand: async (command) => {
      const result = await maybeExecuteJrRpcCustomCommand(command, {
        activeSkill: args.skillSandbox.getActiveSkill(),
        channelConfiguration: args.policy.channelConfiguration,
        requesterId: args.actorRequester?.userId,
        onConfigurationValueChanged: (key, value) => {
          if (value === undefined) {
            delete args.configurationValues[key];
            return;
          }
          args.configurationValues[key] = value;
        },
      });
      return result.handled
        ? { handled: true, result: result.result }
        : { handled: false };
    },
  });
  const currentSandboxExecutor = sandboxExecutor;
  sandboxExecutor.configureSkills(args.availableSkills);
  sandboxExecutor.configureReferenceFiles(listReferenceFiles());
  const sandbox = createLazySandboxWorkspace({
    executor: currentSandboxExecutor,
    spanContext: args.spanContext,
  });

  const slackDestination =
    args.routing.destination.platform === "slack"
      ? args.routing.destination
      : undefined;
  const slackChannelId = slackDestination?.channelId;

  const mcpAuth = createMcpAuthOrchestration({
    abortAgent: args.abortAgent,
    conversationId: args.sessionConversationId,
    sessionId: args.sessionId,
    requesterId: authRequesterId,
    channelId: slackChannelId,
    destination: args.routing.destination,
    source: args.runSource,
    threadTs: args.routing.correlation?.threadTs,
    toolChannelId: args.routing.toolChannelId,
    userMessage: args.userInput,
    pendingAuth: args.state.pendingAuth,
    getConfiguration: () => args.configurationValues,
    getArtifactState: () => args.state.artifactState,
    getMergedArtifactState: () =>
      mergeArtifactsState(
        args.state.artifactState ?? {},
        args.artifactStatePatch,
      ),
    recordPendingAuth: args.durability.recordPendingAuth,
    authorizationFlowMode: args.policy.authorizationFlowMode,
  });
  const pluginAuth = createPluginAuthOrchestration({
    abortAgent: args.abortAgent,
    conversationId: args.sessionConversationId,
    sessionId: args.sessionId,
    requesterId: authRequesterId,
    channelId: slackChannelId,
    destination: args.routing.destination,
    source: args.runSource,
    threadTs: args.routing.correlation?.threadTs,
    userMessage: args.userInput,
    channelConfiguration: args.policy.channelConfiguration,
    pendingAuth: args.state.pendingAuth,
    recordPendingAuth: args.durability.recordPendingAuth,
    authorizationFlowMode: args.policy.authorizationFlowMode,
    userTokenStore,
  });

  const mcpToolManager = new McpToolManager(
    pluginCatalogRuntime.getMcpProviders(),
    {
      authProviderFactory: mcpAuth.authProviderFactory,
      onAuthorizationRequired: mcpAuth.onAuthorizationRequired,
    },
  );
  const activeMcpToolManager = mcpToolManager;
  const getPendingAuthPause = () =>
    pluginAuth.getPendingPause() ?? mcpAuth.getPendingPause();
  setTags({
    conversationId: args.spanContext.conversationId,
    slackThreadId: args.routing.correlation?.threadId,
    slackUserId: args.routing.correlation?.requesterId,
    slackChannelId: args.routing.correlation?.channelId,
    runId: args.routing.correlation?.runId,
    assistantUserName: botConfig.userName,
    modelId: botConfig.modelId,
  });

  const loadableSkills = args.availableSkills.filter(
    (skill) =>
      skill.disableModelInvocation !== true ||
      skill.name === args.invokedSkill?.name,
  );
  let advisorTools: AgentTool[] = [];
  const commonToolRuntimeContext = {
    conversationId: args.sessionConversationId,
    userText: args.userInput,
    artifactState: args.state.artifactState,
    configuration: args.configurationValues,
    egress: createPluginEgress({
      credentialContext: args.routing.credentialContext,
      pluginAuth: {
        async handleAuthRequired(signal) {
          await pluginAuth.maybeHandleAuthSignal({
            auth_required: {
              ...(signal.authorization
                ? { authorization: signal.authorization }
                : {}),
              createdAtMs: Date.now(),
              grant: signal.grant,
              kind: signal.kind,
              message: signal.message,
              provider: signal.provider,
            },
          });
        },
      },
    }),
    mcpToolManager: activeMcpToolManager,
    sandbox,
    surface: args.surface,
    advisor: {
      config: botConfig.advisor,
      conversationId: args.sessionConversationId,
      conversationPrivacy: args.conversationPrivacy,
      parentSessionId: args.sessionId,
      logContext: args.spanContext,
      getTools: () => advisorTools,
      streamFn: createTracedStreamFn({
        conversationPrivacy: args.conversationPrivacy,
      }),
    },
  };
  const toolSource = args.runSource;
  const toolDestination = toolInvocationDestination(args.routing);
  let toolRuntimeContext: ToolRuntimeContext;
  if (toolSource.platform === "slack") {
    if (toolDestination.platform !== "slack") {
      throw new TypeError("Slack tool runtime requires a Slack destination");
    }
    toolRuntimeContext = {
      ...commonToolRuntimeContext,
      destination: toolDestination,
      requester:
        args.actorRequester?.platform === "slack"
          ? args.actorRequester
          : undefined,
      source: toolSource,
    };
  } else {
    if (toolDestination.platform !== "local") {
      throw new TypeError("Local tool runtime requires a local destination");
    }
    toolRuntimeContext = {
      ...commonToolRuntimeContext,
      destination: toolDestination,
      requester:
        args.actorRequester?.platform === "local"
          ? args.actorRequester
          : undefined,
      source: toolSource,
    };
  }
  const tools = createTools(
    loadableSkills,
    {
      getGeneratedFile: (filename) =>
        args.generatedFiles.find((file) => file.filename === filename),
      onGeneratedArtifactFiles: (files) => {
        args.generatedFiles.push(...files);
      },
      onGeneratedFiles: (files) => {
        args.deliveryFiles.push(...files);
      },
      onArtifactStatePatch: async (patch) => {
        Object.assign(args.artifactStatePatch, patch);
        await args.durability.onArtifactStateUpdated?.(
          mergeArtifactsState(
            args.state.artifactState ?? {},
            args.artifactStatePatch,
          ),
        );
      },
      toolOverrides: args.policy.toolOverrides,
      onSkillLoaded: async (loadedSkill) => {
        const resolvedSkill = await args.skillSandbox.loadSkill(
          loadedSkill.name,
        );
        const effective = resolvedSkill ?? loadedSkill;
        upsertActiveSkill(args.activeSkills, effective);
        args.syncLoadedSkillNamesForResume();
        if (await activeMcpToolManager.activateForSkill(effective)) {
          await args.recordConnectedMcpProvider(effective.pluginProvider!);
        }
        if (mcpAuth.getPendingPause()) {
          // Auth pause requested — suppress loadSkill failure and let the
          // aborted run park cleanly.
          return undefined;
        }
        if (!effective.pluginProvider) {
          return undefined;
        }
        if (
          !activeMcpToolManager
            .getActiveProviders()
            .includes(effective.pluginProvider)
        ) {
          return undefined;
        }
        const availableToolCount = activeMcpToolManager.getActiveToolCatalog({
          provider: effective.pluginProvider,
        }).length;
        return {
          mcp_provider: effective.pluginProvider,
          available_tool_count: availableToolCount,
        };
      },
    },
    toolRuntimeContext,
  );

  const toolGuidance = Object.entries(
    tools as Record<string, ToolDefinition<any>>,
  ).map(([name, definition]) => ({
    name,
    promptGuidelines: definition.promptGuidelines,
    promptSnippet: definition.promptSnippet,
  }));

  const pendingMcpProvider =
    args.state.pendingAuth?.kind === "mcp"
      ? args.state.pendingAuth.provider
      : undefined;
  const providersToRestore = new Set([
    ...args.connectedMcpProviders,
    ...inferActiveMcpProvidersFromPiMessages(args.priorPiMessages),
  ]);
  for (const provider of providersToRestore) {
    if (provider === pendingMcpProvider) {
      continue;
    }
    if (await activeMcpToolManager.activateProvider(provider)) {
      await args.recordConnectedMcpProvider(provider);
    }
    if (mcpAuth.getPendingPause()) {
      args.checkpointer.captureResumeSnapshot(args.preAgentPromptMessages());
      throw mcpAuth.getPendingPause()!;
    }
  }
  for (const skill of args.activeSkills) {
    if (skill.pluginProvider === pendingMcpProvider) {
      continue;
    }
    if (await activeMcpToolManager.activateForSkill(skill)) {
      await args.recordConnectedMcpProvider(skill.pluginProvider!);
    }
    if (mcpAuth.getPendingPause()) {
      args.checkpointer.captureResumeSnapshot(args.preAgentPromptMessages());
      throw mcpAuth.getPendingPause()!;
    }
  }

  const activeMcpCatalogs = toActiveMcpCatalogSummaries(
    activeMcpToolManager.getActiveToolCatalog(),
  );
  const onToolCall = async (
    toolName: string,
    params: Record<string, unknown>,
  ) => {
    args.toolCalls.push(toolName);
    try {
      await args.observers.onToolInvocation?.({ toolName, params });
    } catch (error) {
      logWarn(
        "tool_invocation_observer_failed",
        args.spanContext,
        {
          "gen_ai.tool.name": toolName,
          "exception.message":
            error instanceof Error ? error.message : String(error),
        },
        "Tool invocation observer failed",
      );
    }
  };
  const agentTools = createAgentTools(
    tools,
    args.skillSandbox,
    args.spanContext,
    args.observers.onStatus,
    sandboxExecutor,
    pluginAuth,
    onToolCall,
    pluginHooks,
    args.conversationPrivacy,
    args.observers.onToolResult,
  );
  advisorTools = createAgentTools(
    createAdvisorToolDefinitions(tools),
    args.skillSandbox,
    args.spanContext,
    args.observers.onStatus,
    sandboxExecutor,
    pluginAuth,
    onToolCall,
    pluginHooks,
    args.conversationPrivacy,
    args.observers.onToolResult,
  );

  return {
    activeMcpCatalogs,
    agentTools,
    currentSandboxExecutor,
    getPendingAuthPause,
    mcpToolManager,
    pluginHooks,
    toolGuidance,
    toolRuntimeContext,
  };
}
