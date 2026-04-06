import { Agent } from "@mariozechner/pi-agent-core";
import type { FileUpload } from "chat";
import { botConfig } from "@/chat/config";
import {
  extractGenAiUsageAttributes,
  serializeGenAiAttribute,
} from "@/chat/logging";
import { createMcpOAuthClientProvider } from "@/chat/mcp/oauth";
import { getMcpAuthSession, patchMcpAuthSession } from "@/chat/mcp/auth-store";
import {
  getActiveTraceId,
  logException,
  logInfo,
  logWarn,
  setSpanAttributes,
  setTags,
  withSpan,
  type LogContext,
} from "@/chat/logging";
import { deliverPrivateMessage, formatProviderLabel } from "@/chat/oauth-flow";
import { buildSystemPrompt } from "@/chat/prompt";
import {
  createSkillCapabilityRuntime,
  createUserTokenStore,
} from "@/chat/capabilities/factory";
import { maybeExecuteJrRpcCustomCommand } from "@/chat/capabilities/jr-rpc-command";
import { isExplicitChannelPostIntent } from "@/chat/services/channel-intent";
import type { ChannelConfigurationService } from "@/chat/configuration/types";
import {
  buildReplyDeliveryPlan,
  type ReplyDeliveryPlan,
} from "@/chat/services/reply-delivery-plan";
import { SkillSandbox } from "@/chat/sandbox/skill-sandbox";
import {
  discoverSkills,
  findSkillByName,
  parseSkillInvocation,
  type Skill,
} from "@/chat/skills";
import {
  getPluginMcpProviders,
  getPluginProviders,
} from "@/chat/plugins/registry";
import { McpToolManager, type ManagedMcpTool } from "@/chat/mcp/tool-manager";
import type { ThreadArtifactsState } from "@/chat/state/artifacts";
import { createTools } from "@/chat/tools";
import type { ToolDefinition } from "@/chat/tools/definition";
import { toExposedToolSummary } from "@/chat/tools/skill/mcp-tool-summary";
import type { ImageGenerateToolDeps } from "@/chat/tools/types";
import {
  GEN_AI_PROVIDER_NAME,
  getPiGatewayApiKeyOverride,
  resolveGatewayModel,
} from "@/chat/pi/client";
import { createSandboxExecutor } from "@/chat/sandbox/sandbox";
import { getRuntimeMetadata } from "@/chat/config";
import { shouldEmitDevAgentTrace } from "@/chat/runtime/dev-agent-trace";
import {
  getAgentTurnSessionCheckpoint,
  upsertAgentTurnSessionCheckpoint,
} from "@/chat/state/turn-session-store";
import { formatToolStatusWithInput } from "@/chat/runtime/tool-status";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { createAgentTools } from "@/chat/tools/agent-tools";
import { extractOAuthStartedMessageFromToolResults } from "@/chat/oauth-flow";
import { RetryableTurnError, isRetryableTurnError } from "@/chat/runtime/turn";
import { enforceAttachmentClaimTruth } from "@/chat/services/attachment-claims";
import { mergeArtifactsState } from "@/chat/runtime/thread-state";
import {
  buildExecutionFailureMessage,
  buildUserTurnText,
  collectRelevantConfigurationKeys,
  encodeNonImageAttachmentForPrompt,
  extractAssistantText,
  getSessionIdentifiers,
  hasCompletedAssistantTurn,
  isAssistantMessage,
  isExecutionEscapeResponse,
  isRawToolPayloadResponse,
  isToolResultError,
  isToolResultMessage,
  normalizeToolNameFromResult,
  summarizeMessageText,
  toObservablePromptPart,
  trimTrailingAssistantMessages,
  upsertActiveSkill,
} from "@/chat/respond-helpers";

export interface ReplyRequestContext {
  skillDirs?: string[];
  assistant?: {
    userId?: string;
    userName?: string;
  };
  requester?: {
    userId?: string;
    userName?: string;
    fullName?: string;
  };
  correlation?: {
    conversationId?: string;
    threadId?: string;
    turnId?: string;
    runId?: string;
    channelId?: string;
    messageTs?: string;
    threadTs?: string;
    requesterId?: string;
  };
  toolChannelId?: string;
  conversationContext?: string;
  artifactState?: ThreadArtifactsState;
  configuration?: Record<string, unknown>;
  channelConfiguration?: ChannelConfigurationService;
  userAttachments?: Array<{
    data: Buffer;
    mediaType: string;
    filename?: string;
  }>;
  sandbox?: {
    sandboxId?: string;
    sandboxDependencyProfileHash?: string;
  };
  toolOverrides?: {
    imageGenerate?: ImageGenerateToolDeps;
  };
  onStatus?: (status: string) => void | Promise<void>;
  onTextDelta?: (deltaText: string) => void | Promise<void>;
}

export interface AssistantReply {
  text: string;
  files?: FileUpload[];
  artifactStatePatch?: Partial<ThreadArtifactsState>;
  deliveryPlan?: ReplyDeliveryPlan;
  deliveryMode?: "thread" | "channel_only";
  sandboxId?: string;
  sandboxDependencyProfileHash?: string;
  diagnostics: AgentTurnDiagnostics;
}

export interface AgentTurnDiagnostics {
  assistantMessageCount: number;
  errorMessage?: string;
  providerError?: unknown;
  modelId: string;
  outcome: "success" | "execution_failure" | "provider_error";
  stopReason?: string;
  toolCalls: string[];
  toolErrorCount: number;
  toolResultCount: number;
  usedPrimaryText: boolean;
}

let startupDiscoveryLogged = false;

type ResumablePiAgent = Agent & {
  continue?: () => Promise<unknown>;
  replaceMessages?: (messages: unknown[]) => Promise<void> | void;
};

class McpAuthorizationPauseError extends Error {
  readonly provider: string;

  constructor(provider: string) {
    super(`MCP authorization started for ${provider}`);
    this.name = "McpAuthorizationPauseError";
    this.provider = provider;
  }
}

async function maybeReplaceAgentMessages(
  agent: Agent,
  messages: unknown[],
): Promise<boolean> {
  const resumable = agent as ResumablePiAgent;
  if (typeof resumable.replaceMessages !== "function") {
    return false;
  }
  await resumable.replaceMessages(messages);
  return true;
}

async function runAgentContinuation(agent: Agent): Promise<unknown> {
  const resumable = agent as ResumablePiAgent;
  if (typeof resumable.continue !== "function") {
    throw new Error("Agent continuation is unavailable in this runtime");
  }
  return await resumable.continue();
}

/** Convert active MCP tools into ToolDefinition entries for first-class registration. */
function mcpToolsToDefinitions(
  mcpTools: ManagedMcpTool[],
): Record<string, ToolDefinition<any>> {
  const defs: Record<string, ToolDefinition<any>> = {};
  for (const tool of mcpTools) {
    defs[tool.name] = {
      description: tool.description,
      // Raw JSON Schema from MCP servers — not a TypeBox TSchema, but
      // pi-agent-core validates with AJV and the Anthropic provider reads
      // .properties/.required, so raw JSON Schema works at runtime.
      inputSchema: tool.parameters as any,
      execute: async (args: Record<string, unknown>) => tool.execute(args),
    };
  }
  return defs;
}

export async function generateAssistantReply(
  messageText: string,
  context: ReplyRequestContext = {},
): Promise<AssistantReply> {
  let timeoutResumeConversationId: string | undefined;
  let timeoutResumeSessionId: string | undefined;
  let timeoutResumeSliceId = 1;
  let timeoutResumeMessages: unknown[] = [];
  let lastKnownSandboxId: string | undefined = context.sandbox?.sandboxId;
  let lastKnownSandboxDependencyProfileHash: string | undefined =
    context.sandbox?.sandboxDependencyProfileHash;
  let loadedSkillNamesForResume: string[] = [];
  let mcpToolManager: McpToolManager | undefined;
  let pendingMcpAuthorizationPause: McpAuthorizationPauseError | undefined;

  try {
    const shouldTrace = shouldEmitDevAgentTrace();
    const spanContext: LogContext = {
      conversationId:
        context.correlation?.conversationId ??
        context.correlation?.threadId ??
        context.correlation?.runId,
      turnId: context.correlation?.turnId,
      agentId: context.correlation?.turnId,
      slackThreadId: context.correlation?.threadId,
      slackUserId: context.correlation?.requesterId,
      slackChannelId: context.correlation?.channelId,
      runId: context.correlation?.runId,
      assistantUserName: context.assistant?.userName,
      modelId: botConfig.modelId,
    };

    const availableSkills = await discoverSkills({
      additionalRoots: context.skillDirs,
    });
    if (!startupDiscoveryLogged) {
      startupDiscoveryLogged = true;
      const plugins = getPluginProviders();
      const roots = [
        ...new Set(availableSkills.map((skill) => skill.skillPath)),
      ].sort();
      logInfo(
        "startup_discovery_summary",
        spanContext,
        {
          "app.skill.count": availableSkills.length,
          "app.skill.names": availableSkills.map((skill) => skill.name).sort(),
          "file.directories": roots,
          "app.plugin.count": plugins.length,
          "app.plugin.names": plugins
            .map((plugin) => plugin.manifest.name)
            .sort(),
        },
        "Discovered startup SOUL/skills/plugins",
      );
    }
    const configurationValues: Record<string, unknown> = {
      ...(context.configuration ?? {}),
    };
    const userInput = messageText;
    if (shouldTrace) {
      logInfo(
        "agent_message_in",
        spanContext,
        {
          "app.message.kind": "user_inbound",
          "app.message.length": userInput.length,
          "app.message.input": summarizeMessageText(userInput),
          "app.message.attachment_count": context.userAttachments?.length ?? 0,
          "messaging.message.id": context.correlation?.messageTs ?? "",
        },
        "Agent message received",
      );
    }
    const skillInvocation = parseSkillInvocation(userInput, availableSkills);
    const invokedSkill = skillInvocation
      ? findSkillByName(skillInvocation.skillName, availableSkills)
      : null;
    const activeSkills: Skill[] = [];
    const skillSandbox = new SkillSandbox(availableSkills, activeSkills);
    const { conversationId: sessionConversationId, sessionId } =
      getSessionIdentifiers(context);
    const canUseTurnSession = Boolean(sessionConversationId && sessionId);
    timeoutResumeConversationId = sessionConversationId;
    timeoutResumeSessionId = sessionId;
    const existingTurnCheckpoint =
      canUseTurnSession && sessionConversationId && sessionId
        ? await getAgentTurnSessionCheckpoint(sessionConversationId, sessionId)
        : undefined;
    const hasAwaitingResumeCheckpoint = Boolean(
      existingTurnCheckpoint &&
      existingTurnCheckpoint.state === "awaiting_resume" &&
      existingTurnCheckpoint.piMessages.length > 0,
    );
    const resumedFromCheckpoint = hasAwaitingResumeCheckpoint;
    const currentSliceId = hasAwaitingResumeCheckpoint
      ? existingTurnCheckpoint!.sliceId
      : 1;
    timeoutResumeSliceId = currentSliceId;
    const capabilityRuntime = createSkillCapabilityRuntime({
      invocationArgs: skillInvocation?.args,
      requesterId: context.requester?.userId,
      resolveConfiguration: async (key) => configurationValues[key],
    });
    const sandboxExecutor = createSandboxExecutor({
      sandboxId: context.sandbox?.sandboxId,
      sandboxDependencyProfileHash:
        context.sandbox?.sandboxDependencyProfileHash,
      traceContext: spanContext,
      onStatus: context.onStatus,
      runBashCustomCommand: async (command) => {
        const result = await maybeExecuteJrRpcCustomCommand(command, {
          capabilityRuntime,
          activeSkill: skillSandbox.getActiveSkill(),
          channelConfiguration: context.channelConfiguration,
          requesterId: context.requester?.userId,
          channelId: context.correlation?.channelId,
          threadTs: context.correlation?.threadTs,
          userMessage: userInput,
          userTokenStore: createUserTokenStore(),
          onConfigurationValueChanged: (key, value) => {
            if (value === undefined) {
              delete configurationValues[key];
              return;
            }
            configurationValues[key] = value;
          },
        });
        return result.handled
          ? { handled: true, result: result.result }
          : { handled: false };
      },
    });
    lastKnownSandboxId = sandboxExecutor.getSandboxId();
    lastKnownSandboxDependencyProfileHash =
      sandboxExecutor.getDependencyProfileHash();
    sandboxExecutor.configureSkills(availableSkills);
    const sandbox = await sandboxExecutor.createSandbox();

    for (const skillName of existingTurnCheckpoint?.loadedSkillNames ?? []) {
      const preloaded = await skillSandbox.loadSkill(skillName);
      if (preloaded) {
        upsertActiveSkill(activeSkills, preloaded);
      }
    }

    if (invokedSkill) {
      const preloaded = await skillSandbox.loadSkill(invokedSkill.name);
      if (preloaded) {
        upsertActiveSkill(activeSkills, preloaded);
      }
    }

    const userTurnText = buildUserTurnText(
      userInput,
      context.conversationContext,
      {
        sessionContext: { conversationId: sessionConversationId },
        turnContext: { traceId: getActiveTraceId() },
      },
    );

    timeoutResumeMessages = [];
    pendingMcpAuthorizationPause = undefined;
    const generatedFiles: FileUpload[] = [];
    const replyFiles: FileUpload[] = [];
    const artifactStatePatch: Partial<ThreadArtifactsState> = {};
    const toolCalls: string[] = [];
    const mcpAuthSessionIdsByProvider = new Map<string, string>();
    let agent: Agent | undefined;

    mcpToolManager = new McpToolManager(getPluginMcpProviders(), {
      authProviderFactory: async (plugin) => {
        if (
          !sessionConversationId ||
          !sessionId ||
          !context.requester?.userId
        ) {
          return undefined;
        }

        const provider = await createMcpOAuthClientProvider({
          provider: plugin.manifest.name,
          conversationId: sessionConversationId,
          sessionId,
          userId: context.requester.userId,
          userMessage: userInput,
          ...(context.correlation?.channelId
            ? { channelId: context.correlation.channelId }
            : {}),
          ...(context.correlation?.threadTs
            ? { threadTs: context.correlation.threadTs }
            : {}),
          ...(context.toolChannelId
            ? { toolChannelId: context.toolChannelId }
            : {}),
          configuration: configurationValues,
          artifactState: context.artifactState,
        });
        mcpAuthSessionIdsByProvider.set(
          plugin.manifest.name,
          provider.authSessionId,
        );
        return provider;
      },
      onAuthorizationRequired: async (provider) => {
        if (pendingMcpAuthorizationPause) {
          return true;
        }

        const authSessionId = mcpAuthSessionIdsByProvider.get(provider);
        if (!authSessionId || !context.requester?.userId) {
          throw new Error(
            `Missing MCP auth session context for plugin "${provider}"`,
          );
        }

        const latestArtifactState = mergeArtifactsState(
          context.artifactState ?? {},
          artifactStatePatch,
        );
        await patchMcpAuthSession(authSessionId, {
          configuration: { ...configurationValues },
          artifactState: latestArtifactState,
          toolChannelId:
            context.toolChannelId ??
            latestArtifactState.assistantContextChannelId ??
            context.correlation?.channelId,
        });

        const authSession = await getMcpAuthSession(authSessionId);
        if (!authSession?.authorizationUrl) {
          throw new Error(
            `Missing MCP authorization URL for plugin "${provider}"`,
          );
        }

        const delivery = await deliverPrivateMessage({
          channelId: authSession.channelId,
          threadTs: authSession.threadTs,
          userId: authSession.userId,
          text: `<${authSession.authorizationUrl}|Click here to link your ${formatProviderLabel(provider)} MCP access>. Once you've authorized, this thread will continue automatically.`,
        });
        if (!delivery) {
          throw new Error(
            `Unable to deliver MCP authorization link for plugin "${provider}"`,
          );
        }

        pendingMcpAuthorizationPause = new McpAuthorizationPauseError(provider);
        agent?.abort();
        return true;
      },
    });
    const turnMcpToolManager = mcpToolManager;
    const syncResumeState = () => {
      loadedSkillNamesForResume = activeSkills.map((skill) => skill.name);
    };

    setTags({
      conversationId: spanContext.conversationId,
      turnId: spanContext.turnId,
      agentId: spanContext.agentId,
      slackThreadId: context.correlation?.threadId,
      slackUserId: context.correlation?.requesterId,
      slackChannelId: context.correlation?.channelId,
      runId: context.correlation?.runId,
      assistantUserName: context.assistant?.userName,
      modelId: botConfig.modelId,
    });

    const tools = createTools(
      availableSkills,
      {
        getGeneratedFile: (filename) =>
          generatedFiles.find((file) => file.filename === filename),
        onGeneratedArtifactFiles: (files) => {
          generatedFiles.push(...files);
        },
        onGeneratedFiles: (files) => {
          replyFiles.push(...files);
        },
        onArtifactStatePatch: (patch) => {
          Object.assign(artifactStatePatch, patch);
        },
        onToolCallStart: async (toolName, input) => {
          await context.onStatus?.(
            `${formatToolStatusWithInput(toolName, input)}...`,
          );
        },
        toolOverrides: context.toolOverrides,
        onSkillLoaded: async (loadedSkill) => {
          const resolvedSkill = await skillSandbox.loadSkill(loadedSkill.name);
          const effective = resolvedSkill ?? loadedSkill;
          upsertActiveSkill(activeSkills, effective);
          syncResumeState();
          await turnMcpToolManager.activateForSkill(effective);
          syncResumeState();
          if (pendingMcpAuthorizationPause) {
            // Pi turns thrown tool errors into toolResult isError frames. Once
            // auth pause has been requested, stop here and let the aborted turn
            // park cleanly instead of surfacing a fake loadSkill failure.
            return undefined;
          }
          if (!effective.pluginProvider) {
            return undefined;
          }

          // Register newly activated MCP tools as first-class AgentTools so the
          // model sees their schemas directly in the API tools array.
          syncMcpAgentTools();

          return {
            available_tools: turnMcpToolManager
              .getActiveToolCatalog(activeSkills, {
                provider: effective.pluginProvider,
              })
              .map(toExposedToolSummary),
          };
        },
      },
      {
        channelId: context.toolChannelId ?? context.correlation?.channelId,
        messageTs: context.correlation?.messageTs,
        threadTs: context.correlation?.threadTs,
        userText: userInput,
        artifactState: context.artifactState,
        configuration: configurationValues,
        getActiveSkills: () => activeSkills,
        mcpToolManager: turnMcpToolManager,
        sandbox,
      },
    );

    syncResumeState();
    for (const skill of activeSkills) {
      await turnMcpToolManager.activateForSkill(skill);
      syncResumeState();
      if (pendingMcpAuthorizationPause) {
        timeoutResumeMessages = existingTurnCheckpoint?.piMessages ?? [];
        throw pendingMcpAuthorizationPause;
      }
    }
    syncResumeState();

    const activeToolSummaries = turnMcpToolManager
      .getActiveToolCatalog(activeSkills)
      .map(toExposedToolSummary);
    const baseInstructions = buildSystemPrompt({
      availableSkills,
      activeSkills,
      activeTools: activeToolSummaries,
      invocation: skillInvocation,
      assistant: context.assistant,
      requester: context.requester,
      artifactState: context.artifactState,
      configuration: configurationValues,
      relevantConfigurationKeys: collectRelevantConfigurationKeys(
        activeSkills,
        invokedSkill,
      ),
      runtimeMetadata: getRuntimeMetadata(),
    });

    const userContentParts: Array<
      | { type: "text"; text: string }
      | { type: "image"; data: string; mimeType: string }
    > = [{ type: "text", text: userTurnText }];

    for (const attachment of context.userAttachments ?? []) {
      if (attachment.mediaType.startsWith("image/")) {
        userContentParts.push({
          type: "image",
          data: attachment.data.toString("base64"),
          mimeType: attachment.mediaType,
        });
      } else {
        userContentParts.push({
          type: "text",
          text: encodeNonImageAttachmentForPrompt(attachment),
        });
      }
    }

    const inputMessagesAttribute = serializeGenAiAttribute([
      {
        role: "system",
        content: [{ type: "text", text: baseInstructions }],
      },
      {
        role: "user",
        content: userContentParts.map((part) => toObservablePromptPart(part)),
      },
    ]);

    const agentToolHooks = {
      onToolCall: (toolName: string) => {
        toolCalls.push(toolName);
      },
    };
    const baseAgentTools = createAgentTools(
      tools as Record<string, ToolDefinition<any>>,
      skillSandbox,
      spanContext,
      context.onStatus,
      sandboxExecutor,
      capabilityRuntime,
      agentToolHooks,
    );

    // Mutable tools array shared with the agent. Pi-agent-core does not clone
    // this reference, so in-place mutations are visible to the running loop.
    const agentTools: AgentTool[] = [...baseAgentTools];

    /** Rebuild MCP portion of the mutable tools array from current active state. */
    const syncMcpAgentTools = () => {
      const mcpTools = turnMcpToolManager.getResolvedActiveTools(activeSkills);
      const mcpDefs = mcpToolsToDefinitions(mcpTools);
      const mcpAgentTools = createAgentTools(
        mcpDefs,
        skillSandbox,
        spanContext,
        context.onStatus,
        sandboxExecutor,
        capabilityRuntime,
        agentToolHooks,
      );
      agentTools.length = 0;
      agentTools.push(...baseAgentTools, ...mcpAgentTools);
    };

    // Register any MCP tools already active from pre-loaded skills.
    syncMcpAgentTools();

    agent = new Agent({
      getApiKey: () => getPiGatewayApiKeyOverride(),
      initialState: {
        systemPrompt: baseInstructions,
        model: resolveGatewayModel(botConfig.modelId),
        tools: agentTools,
      },
    });
    let hasEmittedText = false;
    let needsSeparator = false;

    const unsubscribe = agent.subscribe((event) => {
      // Track message boundaries so text from consecutive assistant messages
      // is separated by "\n\n", matching final Slack formatting.
      if (event.type === "message_start") {
        if (hasEmittedText) {
          needsSeparator = true;
        }
        return;
      }

      if (event.type !== "message_update") {
        return;
      }

      if (event.assistantMessageEvent.type !== "text_delta") {
        return;
      }

      const deltaText = event.assistantMessageEvent.delta;
      if (!deltaText) {
        return;
      }

      const text = needsSeparator ? "\n\n" + deltaText : deltaText;
      needsSeparator = false;
      hasEmittedText = true;

      Promise.resolve(context.onTextDelta?.(text)).catch((error) => {
        logWarn(
          "streaming_text_delta_error",
          {},
          {
            "error.message":
              error instanceof Error ? error.message : String(error),
          },
          "Failed to deliver text delta to stream",
        );
      });
    });

    let beforeMessageCount = agent.state.messages.length;
    let newMessages: unknown[] = [];
    let completedAssistantTurn = false;

    try {
      if (resumedFromCheckpoint) {
        const didReplace = await maybeReplaceAgentMessages(
          agent,
          existingTurnCheckpoint!.piMessages,
        );
        if (!didReplace) {
          throw new Error(
            "Agent session resume requested but replaceMessages is unavailable",
          );
        }
      }
      beforeMessageCount = agent.state.messages.length;

      await withSpan(
        "ai.generate_assistant_reply",
        "gen_ai.invoke_agent",
        spanContext,
        async () => {
          let promptResult: unknown;
          const promptPromise = resumedFromCheckpoint
            ? runAgentContinuation(agent)
            : agent.prompt({
                role: "user",
                content: userContentParts,
                timestamp: Date.now(),
              });

          let timeoutId: ReturnType<typeof setTimeout> | undefined;
          let didTimeout = false;
          const timeoutPromise = new Promise<never>((_, reject) => {
            timeoutId = setTimeout(() => {
              didTimeout = true;
              agent.abort();
              reject(
                new Error(
                  `Agent turn timed out after ${botConfig.turnTimeoutMs}ms`,
                ),
              );
            }, botConfig.turnTimeoutMs);
          });

          try {
            promptResult = await Promise.race([promptPromise, timeoutPromise]);
          } catch (error) {
            if (didTimeout) {
              logWarn(
                "agent_turn_timeout",
                {},
                {
                  "gen_ai.provider.name": GEN_AI_PROVIDER_NAME,
                  "gen_ai.operation.name": "invoke_agent",
                  "gen_ai.request.model": botConfig.modelId,
                  "app.ai.turn_timeout_ms": botConfig.turnTimeoutMs,
                },
                "Agent turn timed out and was aborted",
              );
              // The timeout branch wins the race via timeoutPromise, so the
              // agent loop may still be settling its final message state. Wait
              // for promptPromise before snapshotting messages for resume.
              await promptPromise.catch(() => {});
              timeoutResumeMessages = [...(agent.state.messages as unknown[])];
            }
            if (pendingMcpAuthorizationPause) {
              // For non-timeout failures, pi-agent-core only settles
              // promptPromise after it has finished mutating agent.state.
              // By the time we get here, the prompt already settled, so the
              // current message snapshot is final for auth-pause checkpointing.
              timeoutResumeMessages = [...(agent.state.messages as unknown[])];
              throw pendingMcpAuthorizationPause;
            }
            throw error;
          } finally {
            if (timeoutId) {
              clearTimeout(timeoutId);
            }
          }

          newMessages = agent.state.messages.slice(
            beforeMessageCount,
          ) as unknown[];
          completedAssistantTurn = hasCompletedAssistantTurn(newMessages);
          if (pendingMcpAuthorizationPause && !completedAssistantTurn) {
            timeoutResumeMessages = [...(agent.state.messages as unknown[])];
            throw pendingMcpAuthorizationPause;
          }
          if (pendingMcpAuthorizationPause && completedAssistantTurn) {
            pendingMcpAuthorizationPause = undefined;
          }
          const outputMessages = newMessages.filter(isAssistantMessage);
          const outputMessagesAttribute =
            serializeGenAiAttribute(outputMessages);
          const usageAttributes = extractGenAiUsageAttributes(
            promptResult,
            agent.state,
            ...outputMessages,
          );
          setSpanAttributes({
            ...(outputMessagesAttribute
              ? { "gen_ai.output.messages": outputMessagesAttribute }
              : {}),
            ...usageAttributes,
          });
        },
        {
          "gen_ai.provider.name": GEN_AI_PROVIDER_NAME,
          "gen_ai.operation.name": "invoke_agent",
          "gen_ai.request.model": botConfig.modelId,
          ...(inputMessagesAttribute
            ? { "gen_ai.input.messages": inputMessagesAttribute }
            : {}),
        },
      );
    } finally {
      unsubscribe();
    }

    if (pendingMcpAuthorizationPause && !completedAssistantTurn) {
      throw pendingMcpAuthorizationPause;
    }

    if (canUseTurnSession && sessionConversationId && sessionId) {
      await upsertAgentTurnSessionCheckpoint({
        conversationId: sessionConversationId,
        sessionId,
        sliceId: currentSliceId,
        state: "completed",
        piMessages: agent.state.messages as unknown[],
        loadedSkillNames: activeSkills.map((skill) => skill.name),
      });
    }

    const toolResults = newMessages.filter(isToolResultMessage);

    const assistantMessages = newMessages.filter(isAssistantMessage);

    const primaryText = assistantMessages
      .map((message) => extractAssistantText(message))
      .join("\n\n")
      .trim();
    const oauthStartedMessage =
      extractOAuthStartedMessageFromToolResults(toolResults);

    const toolErrorCount = toolResults.filter(
      (result) => result.isError,
    ).length;
    const explicitChannelPostIntent = isExplicitChannelPostIntent(userInput);
    const successfulToolNames = new Set(
      toolResults
        .filter((result) => !isToolResultError(result))
        .map((result) => normalizeToolNameFromResult(result))
        .filter((value): value is string => Boolean(value)),
    );
    const channelPostPerformed = successfulToolNames.has(
      "slackChannelPostMessage",
    );
    const deliveryPlan = buildReplyDeliveryPlan({
      explicitChannelPostIntent,
      channelPostPerformed,
      hasFiles: replyFiles.length > 0,
      streamingThreadReply: Boolean(context.onTextDelta),
    });
    const deliveryMode: "thread" | "channel_only" = deliveryPlan.mode;

    if (!primaryText && !oauthStartedMessage) {
      logWarn(
        "ai_model_response_empty",
        {
          slackThreadId: context.correlation?.threadId,
          slackUserId: context.correlation?.requesterId,
          slackChannelId: context.correlation?.channelId,
          runId: context.correlation?.runId,
          assistantUserName: context.assistant?.userName,
          modelId: botConfig.modelId,
        },
        {
          "app.ai.tool_results": toolResults.length,
          "app.ai.tool_error_results": toolErrorCount,
          "app.ai.generated_files": generatedFiles.length,
        },
        "Model returned empty text response",
      );
    }

    const lastAssistant = assistantMessages.at(-1) as
      | { stopReason?: unknown; errorMessage?: unknown }
      | undefined;
    const stopReason =
      typeof lastAssistant?.stopReason === "string"
        ? lastAssistant.stopReason
        : undefined;
    const errorMessage =
      typeof lastAssistant?.errorMessage === "string"
        ? lastAssistant.errorMessage
        : undefined;
    const usedPrimaryText = Boolean(primaryText);
    const outcome: AgentTurnDiagnostics["outcome"] =
      primaryText || oauthStartedMessage
        ? stopReason === "error"
          ? "provider_error"
          : "success"
        : "execution_failure";
    const fallbackText =
      oauthStartedMessage ?? buildExecutionFailureMessage(toolErrorCount);
    const responseText = primaryText || fallbackText;
    const escapedOrRawPayload =
      Boolean(primaryText) &&
      (isExecutionEscapeResponse(primaryText) ||
        isRawToolPayloadResponse(primaryText));
    const resolvedText = escapedOrRawPayload
      ? fallbackText
      : enforceAttachmentClaimTruth(responseText, replyFiles.length > 0);
    const resolvedOutcome: AgentTurnDiagnostics["outcome"] = escapedOrRawPayload
      ? oauthStartedMessage
        ? outcome
        : "execution_failure"
      : outcome;
    if (shouldTrace) {
      logInfo(
        "agent_message_out",
        spanContext,
        {
          "app.message.kind": "assistant_outbound",
          "app.message.length": resolvedText.length,
          "app.message.output": summarizeMessageText(resolvedText),
          "app.ai.outcome": resolvedOutcome,
          "app.ai.assistant_messages": assistantMessages.length,
          ...(stopReason ? { "app.ai.stop_reason": stopReason } : {}),
        },
        "Agent message sent",
      );
    }
    if (escapedOrRawPayload) {
      return {
        text: resolvedText,
        files: replyFiles.length > 0 ? replyFiles : undefined,
        artifactStatePatch:
          Object.keys(artifactStatePatch).length > 0
            ? artifactStatePatch
            : undefined,
        deliveryPlan,
        deliveryMode,
        sandboxId: sandboxExecutor.getSandboxId(),
        sandboxDependencyProfileHash:
          sandboxExecutor.getDependencyProfileHash(),
        diagnostics: {
          outcome: "execution_failure",
          modelId: botConfig.modelId,
          assistantMessageCount: assistantMessages.length,
          toolCalls,
          toolResultCount: toolResults.length,
          toolErrorCount,
          usedPrimaryText,
          stopReason,
          errorMessage,
          providerError: undefined,
        },
      };
    }

    return {
      text: resolvedText,
      files: replyFiles.length > 0 ? replyFiles : undefined,
      artifactStatePatch:
        Object.keys(artifactStatePatch).length > 0
          ? artifactStatePatch
          : undefined,
      deliveryPlan,
      deliveryMode,
      sandboxId: sandboxExecutor.getSandboxId(),
      sandboxDependencyProfileHash: sandboxExecutor.getDependencyProfileHash(),
      diagnostics: {
        outcome,
        modelId: botConfig.modelId,
        assistantMessageCount: assistantMessages.length,
        toolCalls,
        toolResultCount: toolResults.length,
        toolErrorCount,
        usedPrimaryText,
        stopReason,
        errorMessage,
        providerError: undefined,
      },
    };
  } catch (error) {
    if (
      error instanceof McpAuthorizationPauseError &&
      timeoutResumeConversationId &&
      timeoutResumeSessionId
    ) {
      const nextSliceId = timeoutResumeSliceId + 1;
      try {
        const latestCheckpoint = await getAgentTurnSessionCheckpoint(
          timeoutResumeConversationId,
          timeoutResumeSessionId,
        );
        const piMessages = trimTrailingAssistantMessages(
          timeoutResumeMessages.length > 0
            ? timeoutResumeMessages
            : (latestCheckpoint?.piMessages ?? []),
        );
        await upsertAgentTurnSessionCheckpoint({
          conversationId: timeoutResumeConversationId,
          sessionId: timeoutResumeSessionId,
          sliceId: nextSliceId,
          state: "awaiting_resume",
          piMessages,
          loadedSkillNames: loadedSkillNamesForResume,
          resumeReason: "auth",
          resumedFromSliceId: timeoutResumeSliceId,
          errorMessage: error.message,
        });
      } catch (checkpointError) {
        logException(
          checkpointError,
          "agent_turn_auth_resume_checkpoint_failed",
          {
            slackThreadId: context.correlation?.threadId,
            slackUserId: context.correlation?.requesterId,
            slackChannelId: context.correlation?.channelId,
            runId: context.correlation?.runId,
            assistantUserName: context.assistant?.userName,
            modelId: botConfig.modelId,
          },
          {
            "app.ai.resume_conversation_id": timeoutResumeConversationId,
            "app.ai.resume_session_id": timeoutResumeSessionId,
            "app.ai.resume_from_slice_id": timeoutResumeSliceId,
            "app.ai.resume_next_slice_id": nextSliceId,
          },
          "Failed to persist auth checkpoint before retry",
        );
      }
      throw new RetryableTurnError(
        "mcp_auth_resume",
        `conversation=${timeoutResumeConversationId} session=${timeoutResumeSessionId} slice=${nextSliceId}`,
      );
    }

    if (isRetryableTurnError(error)) {
      throw error;
    }

    logException(
      error,
      "assistant_reply_generation_failed",
      {
        slackThreadId: context.correlation?.threadId,
        slackUserId: context.correlation?.requesterId,
        slackChannelId: context.correlation?.channelId,
        runId: context.correlation?.runId,
        assistantUserName: context.assistant?.userName,
        modelId: botConfig.modelId,
      },
      {},
      "generateAssistantReply failed",
    );

    const message = error instanceof Error ? error.message : String(error);
    return {
      text: `Error: ${message}`,
      sandboxId: lastKnownSandboxId,
      sandboxDependencyProfileHash: lastKnownSandboxDependencyProfileHash,
      diagnostics: {
        outcome: "provider_error",
        modelId: botConfig.modelId,
        assistantMessageCount: 0,
        toolCalls: [],
        toolResultCount: 0,
        toolErrorCount: 0,
        usedPrimaryText: false,
        errorMessage: message,
        providerError: error,
      },
    };
  } finally {
    try {
      await mcpToolManager?.close();
    } catch (closeError) {
      logWarn(
        "mcp_tool_manager_close_failed",
        {},
        {
          "error.message":
            closeError instanceof Error
              ? closeError.message
              : String(closeError),
        },
        "Failed to close MCP tool manager",
      );
    }
  }
}
