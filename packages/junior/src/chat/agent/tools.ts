/**
 * Run tool wiring.
 *
 * Builds everything the agent can act through for one run slice: the sandbox
 * access, MCP and plugin auth orchestration, MCP
 * provider restoration from durable history, and the Pi-facing tool surfaces
 * (main-agent tools plus runtime control tools). Auth pauses raised while
 * restoring providers are thrown here so the run parks before prompting.
 */
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { FileUpload } from "chat";
import { createUserTokenStore } from "@/chat/capabilities/factory";
import {
  createAgentSandbox,
  createPluginToolSandbox,
} from "@/chat/agent/sandbox";
import { SkillSandbox } from "@/chat/sandbox/skill-sandbox";
import type { Skill, SkillMetadata } from "@/chat/skills";
import {
  createPluginHookRunner,
  type PluginHookRunner,
} from "@/chat/plugins/agent-hooks";
import { pluginCatalogRuntime } from "@/chat/plugins/catalog-runtime";
import { McpToolManager } from "@/chat/mcp/tool-manager";
import {
  getMcpAwareTelemetryMessage,
  getMcpProviderErrorAttributes,
} from "@/chat/mcp/errors";
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
import type { SandboxRef } from "@/chat/sandbox/ref";
import type { RepositoryInstructions } from "@/chat/repository-instructions";
import { createMcpAuthOrchestration } from "@/chat/services/mcp-auth-orchestration";
import { createPluginAuthOrchestration } from "@/chat/services/plugin-auth-orchestration";
import { createPluginEgress } from "@/chat/egress/plugin";
import type { PiMessage } from "@/chat/pi/messages";
import type { LogContext } from "@/chat/logging";
import { logWarn } from "@/chat/logging";
import type { ConversationPrivacy } from "@/chat/conversation-privacy";
import type { OAuthAuthorization } from "@/chat/oauth-authorization";
import type { Actor } from "@/chat/actor";
import type { AuthorizationPauseError } from "@/chat/services/auth-pause";
import type { AgentTurnSurface } from "@/chat/task-execution/checkpoint";
import {
  isAgentRunFeatureDisabled,
  toolInvocationDestination,
  type AgentRunDurability,
  type AgentRunObservers,
  type AgentRunPolicy,
  type AgentRunRouting,
  type AgentRunState,
} from "@/chat/agent/request";
import { upsertActiveSkill } from "@/chat/agent/skills";
import type { ResumeState } from "@/chat/agent/resume";
import { credentialUserSubjectId } from "@/chat/credentials/context";
import { incrementStat } from "@/stats";
import { botConfig } from "@/chat/config";
import { completeObject } from "@/chat/pi/client";
import { createGuardianActionReviewer } from "@/chat/services/guardian-action-review";
import { createToolActionReview } from "@/chat/tool-support/action-review";
import { buildToolActionEvidence } from "@/chat/tool-support/action-review-evidence";
import { restoreToolActionRejections } from "@/chat/tool-support/action-review-history";
import { recordGuardianActionReviewed } from "@/chat/conversations/projection";
import { readActorIdentity } from "@/chat/plugins/viewer";

interface ToolWiringArgs {
  abortAgent: () => void;
  activeSkills: Skill[];
  currentActor?: Actor;
  /** Live projection of the run's committed instruction-authority actors so far. */
  currentActors?: () => Actor[];
  /** Live Pi transcript used to give Guardian bounded action context. */
  currentAgentMessages: () => PiMessage[];
  /** Durable transcript for this turn only, used to restore rejection state. */
  currentTurnMessages: readonly PiMessage[];
  /** Live same-actor instructions that authorize the pending action. */
  currentUserIntent: () => string;
  availableSkills: SkillMetadata[];
  configurationValues: Record<string, unknown>;
  connectedMcpProviders: Set<string>;
  conversationPrivacy?: ConversationPrivacy;
  durability: AgentRunDurability;
  authorization?: OAuthAuthorization;
  generatedFiles: FileUpload[];
  invokedSkill: SkillMetadata | null;
  observers: AgentRunObservers;
  onFatalToolError(error: Error): void;
  onSandboxRefChanged: (sandboxRef: SandboxRef) => void;
  policy: AgentRunPolicy;
  preAgentPromptMessages: () => PiMessage[];
  priorPiMessages: PiMessage[] | undefined;
  recordConnectedMcpProvider: (provider: string) => Promise<void>;
  requestHandoff?: ToolRuntimeContext["handoff"];
  resume: ResumeState;
  routing: AgentRunRouting;
  conversationId: string;
  turnId: string;
  skillSandbox: SkillSandbox;
  spanContext: LogContext;
  state: AgentRunState;
  supportsImageInput: () => boolean;
  surface: AgentTurnSurface;
  toolCalls: string[];
  userInput: string;
}

/** Record optional reporting without changing the loadSkill outcome. */
async function tryRecordSkillLoadStat(skill: Skill) {
  if (!process.env.DATABASE_URL) return;
  try {
    await incrementStat({
      namespace: skill.pluginProvider ?? "junior",
      metric: "skill_load",
      name: skill.name,
    });
  } catch (error) {
    logWarn("skill.load.stat.failed", {
      "app.skill.name": skill.name,
      "app.plugin.name": skill.pluginProvider,
      "exception.message":
        error instanceof Error ? error.message : String(error),
    });
  }
}

export interface ToolWiring {
  activeMcpCatalogs: ActiveMcpCatalogSummary[];
  agentTools: AgentTool[];
  getPendingAuthPause: () => AuthorizationPauseError | undefined;
  mcpToolManager: McpToolManager;
  pluginHooks: PluginHookRunner;
  /** Project core-owned review state into one durable Pi tool result. */
  projectActionReviewResult<
    TResult extends { details?: unknown; isError?: boolean },
  >(
    toolCallId: string,
    result: TResult,
  ): TResult;
  getSandboxRef: () => SandboxRef | undefined;
  /** Resolve the AGENTS.md bundle selected by the sandbox workspace. */
  captureRepositoryInstructions: () => Promise<
    RepositoryInstructions | undefined
  >;
  close(): Promise<void>;
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
  const credentialUserId = args.routing.credentialContext
    ? credentialUserSubjectId(args.routing.credentialContext)
    : undefined;
  const userTokenStore = createUserTokenStore();
  const pluginHooks = createPluginHookRunner({
    actor: args.currentActor,
    actors: args.currentActors,
  });
  const agentSandbox = createAgentSandbox({
    sandboxRef: args.state.sandboxRef,
    skills: args.availableSkills,
    traceContext: args.spanContext,
    tracePropagation: args.policy.sandboxTracePropagation,
    egressSignals: args.policy.sandboxEgressSignals,
    credentialEgress: args.routing.credentialContext,
    actor: args.currentActor,
    locationConfiguration: args.policy.locationConfiguration,
    configurationValues: args.configurationValues,
    getActiveSkill: () => args.skillSandbox.getActiveSkill(),
    prepareSandbox: pluginHooks.prepareSandbox,
    onSandboxRefChanged: args.onSandboxRefChanged,
    persistSandboxRef: args.durability.onSandboxRefChanged,
  });

  const slackDestination =
    args.routing.destination.platform === "slack"
      ? args.routing.destination
      : undefined;
  const slackChannelId = slackDestination?.channelId;

  const mcpAuth = createMcpAuthOrchestration({
    abortAgent: args.abortAgent,
    conversationId: args.conversationId,
    sessionId: args.turnId,
    actorId: credentialUserId,
    channelId: slackChannelId,
    destination: args.routing.destination,
    source: runSource,
    threadTs:
      args.routing.source.platform === "slack"
        ? args.routing.source.threadTs
        : undefined,
    toolChannelId: args.routing.toolChannelId,
    userMessage: args.userInput,
    pendingAuth: args.state.pendingAuth,
    getConfiguration: () => args.configurationValues,
    recordPendingAuth: args.durability.recordPendingAuth,
    interactiveAuthEnabled: !isAgentRunFeatureDisabled(
      args.policy,
      "interactive-auth",
    ),
    authorization: args.authorization,
  });
  const pluginAuth = createPluginAuthOrchestration({
    abortAgent: args.abortAgent,
    conversationId: args.conversationId,
    sessionId: args.turnId,
    actorId: credentialUserId,
    actor: args.currentActor,
    channelId: slackChannelId,
    destination: args.routing.destination,
    source: runSource,
    threadTs:
      args.routing.source.platform === "slack"
        ? args.routing.source.threadTs
        : undefined,
    userMessage: args.userInput,
    pendingAuth: args.state.pendingAuth,
    recordPendingAuth: args.durability.recordPendingAuth,
    interactiveAuthEnabled: !isAgentRunFeatureDisabled(
      args.policy,
      "interactive-auth",
    ),
    userTokenStore,
    authorization: args.authorization,
  });

  const mcpToolManager = new McpToolManager(
    pluginCatalogRuntime.getMcpProviders(),
    {
      authProviderFactory: mcpAuth.authProviderFactory,
      onAuthorizationRequired: mcpAuth.onAuthorizationRequired,
      onToolSuccess: async (input) => {
        await pluginHooks.afterMcpTool({
          ...input,
          conversationId: args.conversationId,
        });
      },
    },
  );
  const getPendingAuthPause = () =>
    pluginAuth.getPendingPause() ?? mcpAuth.getPendingPause();

  const loadableSkills = args.availableSkills.filter(
    (skill) =>
      skill.disableModelInvocation !== true ||
      skill.name === args.invokedSkill?.name,
  );
  const explicitSkillLoaded = Boolean(
    args.invokedSkill &&
    args.activeSkills.some((skill) => skill.name === args.invokedSkill?.name),
  );
  const commonToolRuntimeContext = {
    conversationId: args.conversationId,
    userText: args.userInput,
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
    workspace: agentSandbox.workspace,
    supportsImageInput: args.supportsImageInput,
    surface: args.surface,
    ...(args.currentActor
      ? {
          resolveActorIdentity: async () =>
            await readActorIdentity(args.currentActor!),
        }
      : {}),
    ...(args.durability.spawnAgent
      ? { spawnAgent: args.durability.spawnAgent }
      : {}),
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
  } else if (runSource.platform === "api") {
    if (toolDestination.platform !== "local") {
      throw new TypeError("API tool runtime requires a local destination");
    }
    toolRuntimeContext = {
      ...commonToolRuntimeContext,
      destination: toolDestination,
      actor:
        args.currentActor?.platform === "api" ? args.currentActor : undefined,
      source: runSource,
    };
  } else {
    if (toolDestination.platform !== "local") {
      throw new TypeError("Local tool runtime requires a local destination");
    }
    if (runSource.platform !== "local") {
      throw new TypeError("Local tool runtime requires a local source");
    }
    toolRuntimeContext = {
      ...commonToolRuntimeContext,
      destination: toolDestination,
      actor:
        args.currentActor?.platform === "local" ? args.currentActor : undefined,
      source: runSource,
    };
  }
  const actionReview = createToolActionReview({
    context: {
      actor: args.currentActor,
      conversationId: args.conversationId,
      credentialContext: args.routing.credentialContext,
      destination: toolDestination,
      source: runSource,
      userIntent: args.currentUserIntent,
      evidence: () => buildToolActionEvidence(args.currentAgentMessages()),
    },
    onDecision: ({ toolCallId, toolName, decision }) =>
      recordGuardianActionReviewed({
        conversationId: args.conversationId,
        turnId: args.turnId,
        toolCallId,
        toolName,
        costUsd: decision.costUsd,
        decision: decision.decision,
        riskLevel: decision.riskLevel,
        userAuthorization: decision.userAuthorization,
      }),
    onFatal: args.onFatalToolError,
    priorRejections: restoreToolActionRejections(args.currentTurnMessages),
    reviewer: createGuardianActionReviewer({
      completeObject,
      modelId: botConfig.guardianModelId,
    }),
  });
  const tools = createTools(
    loadableSkills,
    {
      writeGeneratedArtifacts: async (files) => {
        const refs = await agentSandbox.writeGeneratedArtifacts(files);
        args.generatedFiles.push(...files);
        return refs;
      },
      toolOverrides: args.policy.toolOverrides,
      onSkillLoaded: async (loadedSkill) => {
        const resolvedSkill = await args.skillSandbox.loadSkill(
          loadedSkill.name,
        );
        const effective = resolvedSkill ?? loadedSkill;
        upsertActiveSkill(args.activeSkills, effective);
        if (await mcpToolManager.activateForSkill(effective)) {
          await args.recordConnectedMcpProvider(effective.pluginProvider!);
        }
        await tryRecordSkillLoadStat(effective);
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
    {
      includeLoadSkill: !explicitSkillLoaded,
      pluginSandbox: createPluginToolSandbox(agentSandbox, {
        handleAuthSignal: pluginAuth.maybeHandleAuthSignal,
      }),
    },
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

  // Conversation history records prior capability use, not authority for the
  // current turn. Credentialless system turns must not reconnect user-owned
  // MCP providers merely because an earlier user turn activated them.
  if (credentialUserId) {
    // Restore providers visible in durable Pi session history. In serverless
    // runtimes, later slices and follow-up turns usually run in a fresh
    // process, so in-memory MCP clients cannot be reused.
    const providersToRestore = new Set([
      ...args.connectedMcpProviders,
      ...inferActiveMcpProvidersFromPiMessages(args.priorPiMessages),
      ...args.activeSkills.flatMap((skill) =>
        skill.pluginProvider ? [skill.pluginProvider] : [],
      ),
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
  }

  const activeMcpCatalogs = toActiveMcpCatalogSummaries(
    mcpToolManager.getActiveToolCatalog(),
  );
  const onToolCall = async (
    toolCallId: string,
    toolName: string,
    params: Record<string, unknown>,
  ) => {
    args.toolCalls.push(toolName);
    try {
      await args.observers.onToolInvocation?.({
        params,
        toolCallId,
        toolName,
      });
    } catch (error) {
      logWarn("tool.invocation.observer.failed", {
        "gen_ai.tool.name": toolName,
        "exception.message":
          error instanceof Error ? error.message : String(error),
      });
    }
  };
  const agentTools = createPiAgentTools(
    tools,
    args.skillSandbox,
    args.spanContext,
    args.observers.onStatus,
    agentSandbox.tools,
    pluginAuth,
    onToolCall,
    pluginHooks,
    args.conversationPrivacy,
    args.observers.onToolResult,
    actionReview,
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
    projectActionReviewResult(toolCallId, result) {
      return actionReview.projectToolResult(toolCallId, result);
    },
    getSandboxRef: agentSandbox.sandboxRef,
    captureRepositoryInstructions: agentSandbox.captureRepositoryInstructions,
    async close() {
      agentSandbox.close();
      try {
        await mcpToolManager.close();
      } catch (closeError) {
        logWarn("mcp.tool_manager.close.failed", {
          ...getMcpProviderErrorAttributes(closeError),
          "exception.message": getMcpAwareTelemetryMessage(
            closeError,
            args.conversationPrivacy,
          ),
        });
      }
    },
    toolGuidance,
    toolRuntimeContext,
  };
}
