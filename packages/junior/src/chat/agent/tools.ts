/**
 * Run tool wiring.
 *
 * Builds everything the agent can act through for one run slice: the sandbox
 * executor and lazy workspace, MCP and plugin auth orchestration, MCP
 * provider restoration from durable history, and the Pi-facing tool surfaces
 * (main-agent tools plus runtime control tools). Auth pauses raised while
 * restoring providers are thrown here so the run parks before prompting.
 */
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { FileUpload } from "chat";
import { listReferenceFiles } from "@/chat/discovery";
import { maybeExecuteJrRpcCustomCommand } from "@/chat/capabilities/jr-rpc-command";
import { createUserTokenStore } from "@/chat/capabilities/factory";
import { SkillSandbox } from "@/chat/sandbox/skill-sandbox";
import type { Skill, SkillMetadata } from "@/chat/skills";
import {
  createPluginHookRunner,
  type PluginHookRunner,
} from "@/chat/plugins/agent-hooks";
import { pluginCatalogRuntime } from "@/chat/plugins/catalog-runtime";
import { McpToolManager } from "@/chat/mcp/tool-manager";
import { inferActiveMcpProvidersFromPiMessages } from "@/chat/pi/derived-state";
import { createTools } from "@/chat/tools";
import type { AnyToolDefinition } from "@/chat/tools/definition";
import type { ToolRuntimeContext } from "@/chat/tools/types";
import {
  toActiveMcpCatalogSummaries,
  type ActiveMcpCatalogSummary,
} from "@/chat/tool-support/skill/mcp-tool-summary";
import { createPiAgentTools } from "@/chat/tool-support/pi-tool-adapter";
import { planToolExposure } from "@/chat/tool-exposure";
import {
  createSandboxExecutor,
  type SandboxExecutor,
} from "@/chat/sandbox/sandbox";
import { createMcpAuthOrchestration } from "@/chat/services/mcp-auth-orchestration";
import { createPluginAuthOrchestration } from "@/chat/services/plugin-auth-orchestration";
import { createPluginEgress } from "@/chat/egress/plugin";
import type { PiMessage } from "@/chat/pi/messages";
import type { LogContext } from "@/chat/logging";
import { logWarn } from "@/chat/logging";
import type { ConversationPrivacy } from "@/chat/conversation-privacy";
import { mergeArtifactsState } from "@/chat/runtime/thread-state";
import { isUserActor, type Actor } from "@/chat/actor";
import type { ThreadArtifactsState } from "@/chat/state/artifacts";
import type { AuthorizationPauseError } from "@/chat/services/auth-pause";
import type { AgentTurnSurface } from "@/chat/state/turn-session";
import {
  toolInvocationDestination,
  type AgentRunDurability,
  type AgentRunObservers,
  type AgentRunPolicy,
  type AgentRunRouting,
  type AgentRunState,
} from "@/chat/agent/request";
import { createLazySandboxWorkspace } from "@/chat/agent/sandbox";
import { upsertActiveSkill } from "@/chat/agent/skills";
import type { ResumeState } from "@/chat/agent/resume";
import { writeSandboxGeneratedArtifacts } from "@/chat/runtime/generated-artifacts";

interface ToolWiringArgs {
  abortAgent: () => void;
  activeSkills: Skill[];
  currentActor?: Actor;
  /** Live projection of the run's committed instruction-authority actors so far. */
  currentActors?: () => Actor[];
  artifactStatePatch: Partial<ThreadArtifactsState>;
  availableSkills: SkillMetadata[];
  configurationValues: Record<string, unknown>;
  connectedMcpProviders: Set<string>;
  conversationPrivacy?: ConversationPrivacy;
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
  requestHandoff?: ToolRuntimeContext["handoff"];
  resume: ResumeState;
  routing: AgentRunRouting;
  sessionConversationId?: string;
  sessionId?: string;
  skillSandbox: SkillSandbox;
  spanContext: LogContext;
  state: AgentRunState;
  surface?: AgentTurnSurface;
  syncLoadedSkillNamesForResume: () => void;
  toolCalls: string[];
  userInput: string;
}

export interface ToolWiring {
  activeMcpCatalogs: ActiveMcpCatalogSummary[];
  agentTools: AgentTool[];
  getPendingAuthPause: () => AuthorizationPauseError | undefined;
  mcpToolManager: McpToolManager;
  pluginHooks: PluginHookRunner;
  sandboxExecutor: SandboxExecutor;
  toolGuidance: Array<{
    name: string;
    promptGuidelines: AnyToolDefinition["promptGuidelines"];
    promptSnippet: AnyToolDefinition["promptSnippet"];
  }>;
  toolRuntimeContext: ToolRuntimeContext;
}

/** Wire sandbox, auth orchestration, MCP restoration, and Pi tool surfaces for one slice. */
export async function wireAgentTools(
  args: ToolWiringArgs,
): Promise<ToolWiring> {
  const runSource = args.routing.source;
  const authActorId =
    args.routing.credentialContext &&
    "type" in args.routing.credentialContext.actor
      ? args.routing.credentialContext.actor.userId
      : undefined;
  const userTokenStore = createUserTokenStore();
  const pluginHooks = createPluginHookRunner({
    actor: args.currentActor,
    actors: args.currentActors,
  });
  const sandboxExecutor = createSandboxExecutor({
    sandboxId: args.state.sandbox?.sandboxId,
    sandboxDependencyProfileHash:
      args.state.sandbox?.sandboxDependencyProfileHash,
    traceContext: args.spanContext,
    tracePropagation: args.policy.sandboxTracePropagation,
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
        actorId: isUserActor(args.currentActor)
          ? args.currentActor.userId
          : undefined,
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
  sandboxExecutor.configureSkills(args.availableSkills);
  sandboxExecutor.configureReferenceFiles(listReferenceFiles());
  const sandbox = createLazySandboxWorkspace({
    executor: sandboxExecutor,
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
    actorId: authActorId,
    channelId: slackChannelId,
    destination: args.routing.destination,
    source: runSource,
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
    actorId: authActorId,
    channelId: slackChannelId,
    destination: args.routing.destination,
    source: runSource,
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
  const getPendingAuthPause = () =>
    pluginAuth.getPendingPause() ?? mcpAuth.getPendingPause();

  const loadableSkills = args.availableSkills.filter(
    (skill) =>
      skill.disableModelInvocation !== true ||
      skill.name === args.invokedSkill?.name,
  );
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
    mcpToolManager,
    sandbox,
    surface: args.surface,
    ...(args.requestHandoff ? { handoff: args.requestHandoff } : {}),
  };
  const toolDestination = toolInvocationDestination(args.routing);
  let toolRuntimeContext: ToolRuntimeContext;
  if (runSource.platform === "slack") {
    if (toolDestination.platform !== "slack") {
      throw new TypeError("Slack tool runtime requires a Slack destination");
    }
    toolRuntimeContext = {
      ...commonToolRuntimeContext,
      destination: toolDestination,
      actor:
        args.currentActor?.platform === "slack" ? args.currentActor : undefined,
      source: runSource,
      slackActionToken: args.routing.slackActionToken,
    };
  } else {
    if (toolDestination.platform !== "local") {
      throw new TypeError("Local tool runtime requires a local destination");
    }
    toolRuntimeContext = {
      ...commonToolRuntimeContext,
      destination: toolDestination,
      actor:
        args.currentActor?.platform === "local" ? args.currentActor : undefined,
      source: runSource,
    };
  }
  const tools = createTools(
    loadableSkills,
    {
      writeGeneratedArtifacts: async (files) => {
        const refs = await writeSandboxGeneratedArtifacts(
          await sandboxExecutor.createSandbox(),
          files,
        );
        args.generatedFiles.push(...files);
        return refs;
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
        if (await mcpToolManager.activateForSkill(effective)) {
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
          !mcpToolManager
            .getActiveProviders()
            .includes(effective.pluginProvider)
        ) {
          return undefined;
        }
        const availableToolCount = mcpToolManager.getActiveToolCatalog({
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

  const plannedToolExposure = planToolExposure(
    tools as Record<string, AnyToolDefinition>,
  );
  const toolGuidance = Object.entries(plannedToolExposure.directTools).map(
    ([name, definition]) => ({
      name,
      promptGuidelines: definition.promptGuidelines,
      promptSnippet: definition.promptSnippet,
    }),
  );

  // If a prior turn left an MCP provider pending user authorization, skip
  // eager restoration of that provider here. Without this guard, a later
  // unrelated turn in the same conversation can try to activate the
  // still-unauthenticated provider, throw McpAuthorizationPauseError, and
  // abort before the agent sees the user's request.
  //
  // Skipping only suppresses the eager-restore path. The agent can still
  // trigger the auth flow intentionally (via loadSkill + searchMcpTools)
  // when the user's request genuinely requires that provider.
  const pendingMcpProvider =
    args.state.pendingAuth?.kind === "mcp"
      ? args.state.pendingAuth.provider
      : undefined;

  // Restore providers visible in durable Pi session history. In serverless
  // runtimes, later slices and follow-up turns usually run in a fresh
  // process, so in-memory MCP clients cannot be reused.
  const providersToRestore = new Set([
    ...args.connectedMcpProviders,
    ...inferActiveMcpProvidersFromPiMessages(args.priorPiMessages),
  ]);
  for (const provider of providersToRestore) {
    if (provider === pendingMcpProvider) {
      continue; // awaiting user authorization — skip to avoid aborting unrelated turns
    }
    if (await mcpToolManager.activateProvider(provider)) {
      await args.recordConnectedMcpProvider(provider);
    }
    if (mcpAuth.getPendingPause()) {
      args.resume.captureResumeSnapshot(args.preAgentPromptMessages());
      throw mcpAuth.getPendingPause()!;
    }
  }
  // Activate MCP for skills recovered from durable Pi history.
  for (const skill of args.activeSkills) {
    if (skill.pluginProvider === pendingMcpProvider) {
      continue; // awaiting user authorization — skip to avoid aborting unrelated turns
    }
    if (await mcpToolManager.activateForSkill(skill)) {
      await args.recordConnectedMcpProvider(skill.pluginProvider!);
    }
    if (mcpAuth.getPendingPause()) {
      args.resume.captureResumeSnapshot(args.preAgentPromptMessages());
      throw mcpAuth.getPendingPause()!;
    }
  }

  const activeMcpCatalogs = toActiveMcpCatalogSummaries(
    mcpToolManager.getActiveToolCatalog(),
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
  const agentTools = createPiAgentTools(
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
  // Keep Pi's native tool schema static for the whole turn. Ideally this
  // would use provider-native tool loading/search APIs, but Pi's generic
  // AgentTool surface cannot yet express OpenAI/Anthropic deferred MCP tools.
  // Until it can, MCP tools are searched/disclosed as data and executed
  // through callMcpTool so provider cache/session affinity never sees a
  // mid-run native tool-list mutation.

  return {
    activeMcpCatalogs,
    agentTools,
    getPendingAuthPause,
    mcpToolManager,
    pluginHooks,
    sandboxExecutor,
    toolGuidance,
    toolRuntimeContext,
  };
}
