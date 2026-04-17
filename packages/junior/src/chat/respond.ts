import { Agent, type AgentMessage } from "@mariozechner/pi-agent-core";
import type { FileUpload } from "chat";
import { botConfig } from "@/chat/config";
import {
  extractGenAiUsageSummary,
  getActiveTraceId,
  logException,
  logInfo,
  logWarn,
  serializeGenAiAttribute,
  setSpanAttributes,
  setTags,
  withSpan,
  type LogContext,
} from "@/chat/logging";
import { listReferenceFiles } from "@/chat/discovery";
import { buildSystemPrompt } from "@/chat/prompt";
import {
  createSkillCapabilityRuntime,
  createUserTokenStore,
} from "@/chat/capabilities/factory";
import { maybeExecuteJrRpcCustomCommand } from "@/chat/capabilities/jr-rpc-command";
import type { ChannelConfigurationService } from "@/chat/configuration/types";
import { CredentialUnavailableError } from "@/chat/credentials/broker";
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
import { resolveChannelCapabilities } from "@/chat/tools/channel-capabilities";
import type { ToolDefinition } from "@/chat/tools/definition";
import { toExposedToolSummary } from "@/chat/tools/skill/mcp-tool-summary";
import type { ImageGenerateToolDeps } from "@/chat/tools/types";
import {
  GEN_AI_PROVIDER_NAME,
  getPiGatewayApiKeyOverride,
  resolveGatewayModel,
} from "@/chat/pi/client";
import {
  createSandboxExecutor,
  type SandboxAcquiredState,
  type SandboxExecutor,
} from "@/chat/sandbox/sandbox";
import type { SandboxWorkspace } from "@/chat/sandbox/workspace";
import { getRuntimeMetadata } from "@/chat/config";
import { shouldEmitDevAgentTrace } from "@/chat/runtime/dev-agent-trace";
import type { AssistantStatusSpec } from "@/chat/slack/assistant-thread/status";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { createAgentTools } from "@/chat/tools/agent-tools";
import { mergeArtifactsState } from "@/chat/runtime/thread-state";
import { RetryableTurnError, isRetryableTurnError } from "@/chat/runtime/turn";
import {
  buildUserTurnText,
  collectRelevantConfigurationKeys,
  encodeNonImageAttachmentForPrompt,
  getSessionIdentifiers,
  hasCompletedAssistantTurn,
  isAssistantMessage,
  summarizeMessageText,
  toObservablePromptPart,
  upsertActiveSkill,
} from "@/chat/respond-helpers";
import {
  buildTurnResult,
  type AssistantReply,
  type AgentTurnDiagnostics,
} from "@/chat/services/turn-result";
import type { AgentTurnUsage } from "@/chat/usage";
import {
  loadTurnCheckpoint,
  persistCompletedCheckpoint,
  persistAuthPauseCheckpoint,
  persistTimeoutCheckpoint,
} from "@/chat/services/turn-checkpoint";
import {
  createMcpAuthOrchestration,
  McpAuthorizationPauseError,
} from "@/chat/services/mcp-auth-orchestration";
import {
  createPluginAuthOrchestration,
  PluginAuthorizationPauseError,
} from "@/chat/services/plugin-auth-orchestration";

// Re-export types for backward compatibility with existing consumers.
export type { AssistantReply, AgentTurnDiagnostics };

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
    data?: Buffer;
    mediaType: string;
    filename?: string;
    promptText?: string;
  }>;
  inboundAttachmentCount?: number;
  omittedImageAttachmentCount?: number;
  sandbox?: {
    sandboxId?: string;
    sandboxDependencyProfileHash?: string;
  };
  onSandboxAcquired?: (sandbox: SandboxAcquiredState) => void | Promise<void>;
  onArtifactStateUpdated?: (
    artifactState: ThreadArtifactsState,
  ) => void | Promise<void>;
  toolOverrides?: {
    imageGenerate?: ImageGenerateToolDeps;
  };
  onStatus?: (status: AssistantStatusSpec) => void | Promise<void>;
  onTextDelta?: (deltaText: string) => void | Promise<void>;
  onToolCall?: (toolName: string) => void | Promise<void>;
  onAssistantMessageStart?: () => void | Promise<void>;
  /**
   * Known thread participants. Injected into the system prompt so the LLM can
   * produce correct <@USERID> mention syntax for people already in the conversation.
   */
  threadParticipants?: Array<{
    userId?: string;
    userName?: string;
    fullName?: string;
  }>;
}

let startupDiscoveryLogged = false;

function buildOmittedImageAttachmentNotice(count: number): string {
  return [
    "<omitted-image-attachments>",
    `count: ${count}`,
    "Slack included image attachments with this turn, but this runtime cannot analyze images because no vision model is configured.",
    "Do not claim that no image was attached.",
    "If the user asks about image contents, explain that image analysis is unavailable in this runtime and continue with any text or non-image files that are still available.",
    "</omitted-image-attachments>",
  ].join("\n");
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

/** Run a full agent turn: discover skills, execute tools, and return the assistant reply. */
export async function generateAssistantReply(
  messageText: string,
  context: ReplyRequestContext = {},
): Promise<AssistantReply> {
  const replyStartedAtMs = Date.now();
  let timeoutResumeConversationId: string | undefined;
  let timeoutResumeSessionId: string | undefined;
  let timeoutResumeSliceId = 1;
  let timeoutResumeMessages: AgentMessage[] = [];
  let lastKnownSandboxId: string | undefined = context.sandbox?.sandboxId;
  let lastKnownSandboxDependencyProfileHash: string | undefined =
    context.sandbox?.sandboxDependencyProfileHash;
  let loadedSkillNamesForResume: string[] = [];
  let mcpToolManager: McpToolManager | undefined;
  let sandboxExecutor: SandboxExecutor | undefined;
  let timedOut = false;
  let turnUsage: AgentTurnUsage | undefined;

  const getSandboxMetadata = () =>
    sandboxExecutor
      ? {
          sandboxId: sandboxExecutor.getSandboxId(),
          sandboxDependencyProfileHash:
            sandboxExecutor.getDependencyProfileHash(),
        }
      : {
          sandboxId: lastKnownSandboxId,
          sandboxDependencyProfileHash: lastKnownSandboxDependencyProfileHash,
        };

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

    // ── Skill discovery ──────────────────────────────────────────────
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
    let baseInstructions = "";
    let configurationValues: Record<string, unknown>;
    const userInput = messageText;
    if (shouldTrace) {
      const inboundAttachmentCount = context.inboundAttachmentCount ?? 0;
      const promptAttachmentCount = context.userAttachments?.length ?? 0;
      logInfo(
        "agent_message_in",
        spanContext,
        {
          "app.message.kind": "user_inbound",
          "app.message.length": userInput.length,
          "app.message.input": summarizeMessageText(userInput),
          // Log both counts so image uploads filtered by vision/config do not
          // look indistinguishable from Slack ingress dropping attachments.
          "app.message.attachment_count": inboundAttachmentCount,
          "app.message.prompt_attachment_count": promptAttachmentCount,
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

    // ── Turn checkpoint ──────────────────────────────────────────────
    const { conversationId: sessionConversationId, sessionId } =
      getSessionIdentifiers(context);
    const checkpointState = await loadTurnCheckpoint({
      conversationId: sessionConversationId,
      sessionId,
    });
    const { resumedFromCheckpoint, currentSliceId, existingCheckpoint } =
      checkpointState;
    timeoutResumeConversationId = sessionConversationId;
    timeoutResumeSessionId = sessionId;
    timeoutResumeSliceId = currentSliceId;
    const persistedConfigurationValues = context.channelConfiguration
      ? await context.channelConfiguration.resolveValues()
      : {};
    configurationValues = {
      ...(context.configuration ?? {}),
      ...persistedConfigurationValues,
    };

    // ── Sandbox ──────────────────────────────────────────────────────
    const capabilityRuntime = createSkillCapabilityRuntime({
      requesterId: context.requester?.userId,
    });
    const userTokenStore = createUserTokenStore();
    sandboxExecutor = createSandboxExecutor({
      sandboxId: context.sandbox?.sandboxId,
      sandboxDependencyProfileHash:
        context.sandbox?.sandboxDependencyProfileHash,
      traceContext: spanContext,
      onStatus: context.onStatus,
      onSandboxAcquired: async (sandbox) => {
        lastKnownSandboxId = sandbox.sandboxId;
        lastKnownSandboxDependencyProfileHash =
          sandbox.sandboxDependencyProfileHash;
        await context.onSandboxAcquired?.(sandbox);
      },
      runBashCustomCommand: async (command) => {
        const result = await maybeExecuteJrRpcCustomCommand(command, {
          activeSkill: skillSandbox.getActiveSkill(),
          channelConfiguration: context.channelConfiguration,
          requesterId: context.requester?.userId,
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
    const currentSandboxExecutor = sandboxExecutor;
    sandboxExecutor.configureSkills(availableSkills);
    sandboxExecutor.configureReferenceFiles(listReferenceFiles());
    let sandboxPromise: Promise<SandboxWorkspace> | undefined;
    let sandboxPromiseId: string | undefined;
    const clearSandboxPromise = (): void => {
      sandboxPromise = undefined;
      sandboxPromiseId = undefined;
    };
    const getSandbox = (reason: {
      trigger: string;
      path?: string;
      cmd?: string;
      cwd?: string;
    }): Promise<SandboxWorkspace> => {
      const currentSandboxId = currentSandboxExecutor.getSandboxId();
      if (
        sandboxPromise &&
        sandboxPromiseId &&
        currentSandboxId !== sandboxPromiseId
      ) {
        clearSandboxPromise();
      }

      if (!sandboxPromise) {
        logInfo(
          "sandbox_boot_requested",
          spanContext,
          {
            "app.sandbox.boot.trigger": reason.trigger,
            ...(reason.path ? { "file.path": reason.path } : {}),
            ...(reason.cmd ? { "process.executable.name": reason.cmd } : {}),
            ...(reason.cwd ? { "file.directory": reason.cwd } : {}),
          },
          "Lazy sandbox boot requested",
        );
        sandboxPromise = currentSandboxExecutor
          .createSandbox()
          .then((sandbox) => {
            sandboxPromiseId = sandbox.sandboxId;
            return sandbox;
          })
          .catch((error) => {
            clearSandboxPromise();
            throw error;
          });
      }
      return sandboxPromise;
    };
    const sandbox: SandboxWorkspace = {
      readFileToBuffer: async (input) =>
        (
          await getSandbox({
            trigger: "workspace.readFileToBuffer",
            path: input.path,
          })
        ).readFileToBuffer(input),
      runCommand: async (input) =>
        (
          await getSandbox({
            trigger: "workspace.runCommand",
            cmd: input.cmd,
            cwd: input.cwd,
          })
        ).runCommand(input),
    };

    // ── Preload skills from checkpoint ───────────────────────────────
    for (const skillName of existingCheckpoint?.loadedSkillNames ?? []) {
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

    // ── Mutable turn state ───────────────────────────────────────────
    timeoutResumeMessages = [];
    const generatedFiles: FileUpload[] = [];
    const replyFiles: FileUpload[] = [];
    const artifactStatePatch: Partial<ThreadArtifactsState> = {};
    const toolCalls: string[] = [];
    let agent: Agent | undefined;

    // ── MCP auth orchestration ───────────────────────────────────────
    const mcpAuth = createMcpAuthOrchestration(
      {
        conversationId: sessionConversationId,
        sessionId,
        requesterId: context.requester?.userId,
        channelId: context.correlation?.channelId,
        threadTs: context.correlation?.threadTs,
        toolChannelId: context.toolChannelId,
        userMessage: userInput,
        getConfiguration: () => configurationValues,
        getArtifactState: () => context.artifactState,
        getMergedArtifactState: () =>
          mergeArtifactsState(context.artifactState ?? {}, artifactStatePatch),
      },
      () => agent?.abort(),
    );
    const pluginAuth = createPluginAuthOrchestration(
      {
        conversationId: sessionConversationId,
        sessionId,
        requesterId: context.requester?.userId,
        channelId: context.correlation?.channelId,
        threadTs: context.correlation?.threadTs,
        userMessage: userInput,
        channelConfiguration: context.channelConfiguration,
        userTokenStore,
      },
      () => agent?.abort(),
    );

    mcpToolManager = new McpToolManager(getPluginMcpProviders(), {
      authProviderFactory: mcpAuth.authProviderFactory,
      onAuthorizationRequired: mcpAuth.onAuthorizationRequired,
    });
    const turnMcpToolManager = mcpToolManager;
    const getPendingAuthPause = () =>
      pluginAuth.getPendingPause() ?? mcpAuth.getPendingPause();
    const syncResumeState = () => {
      loadedSkillNamesForResume = activeSkills.map((skill) => skill.name);
    };
    const enableSkillCredentials = async (
      skill: Skill | null,
      reason: string,
    ): Promise<void> => {
      if (!skill?.pluginProvider) {
        return;
      }

      try {
        await capabilityRuntime.enableCredentialsForTurn({
          activeSkill: skill,
          reason,
        });
      } catch (error) {
        if (
          error instanceof CredentialUnavailableError &&
          context.requester?.userId
        ) {
          await pluginAuth.handleCredentialUnavailable({
            activeSkill: skill,
            error,
          });
        }
        throw error;
      }
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

    // ── Tool creation ────────────────────────────────────────────────
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
        onArtifactStatePatch: async (patch) => {
          Object.assign(artifactStatePatch, patch);
          await context.onArtifactStateUpdated?.(
            mergeArtifactsState(
              context.artifactState ?? {},
              artifactStatePatch,
            ),
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
          if (mcpAuth.getPendingPause()) {
            // Auth pause requested — suppress loadSkill failure and let the
            // aborted turn park cleanly.
            return undefined;
          }
          await enableSkillCredentials(
            effective,
            `skill:${effective.name}:turn:load`,
          );
          if (!effective.pluginProvider) {
            return undefined;
          }
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
        channelCapabilities: resolveChannelCapabilities(
          context.toolChannelId ?? context.correlation?.channelId,
        ),
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
      if (mcpAuth.getPendingPause()) {
        timeoutResumeMessages = existingCheckpoint?.piMessages ?? [];
        throw mcpAuth.getPendingPause()!;
      }
      await enableSkillCredentials(skill, `skill:${skill.name}:turn:resume`);
    }
    syncResumeState();

    // ── System prompt ────────────────────────────────────────────────
    const activeToolSummaries = turnMcpToolManager
      .getActiveToolCatalog(activeSkills)
      .map(toExposedToolSummary);
    baseInstructions = buildSystemPrompt({
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
      threadParticipants: context.threadParticipants,
    });

    const userContentParts: Array<
      | { type: "text"; text: string }
      | { type: "image"; data: string; mimeType: string }
    > = [{ type: "text", text: userTurnText }];

    const omittedImageAttachmentCount =
      context.omittedImageAttachmentCount ?? 0;
    if (omittedImageAttachmentCount > 0) {
      userContentParts.push({
        type: "text",
        text: buildOmittedImageAttachmentNotice(omittedImageAttachmentCount),
      });
    }

    for (const attachment of context.userAttachments ?? []) {
      if (attachment.promptText) {
        userContentParts.push({
          type: "text",
          text: attachment.promptText,
        });
      } else if (attachment.mediaType.startsWith("image/")) {
        if (!attachment.data) {
          throw new Error("Image attachment is missing image data");
        }
        userContentParts.push({
          type: "image",
          data: attachment.data.toString("base64"),
          mimeType: attachment.mediaType,
        });
      } else {
        if (!attachment.data) {
          throw new Error("Attachment is missing attachment data");
        }
        const promptAttachment = {
          data: attachment.data,
          mediaType: attachment.mediaType,
          filename: attachment.filename,
        };
        userContentParts.push({
          type: "text",
          text: encodeNonImageAttachmentForPrompt(promptAttachment),
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

    // ── Agent tools ──────────────────────────────────────────────────
    const agentToolHooks = {
      onToolCall: (toolName: string) => {
        toolCalls.push(toolName);
        Promise.resolve(context.onToolCall?.(toolName)).catch((error) => {
          logWarn(
            "streaming_tool_call_error",
            {},
            {
              "error.message":
                error instanceof Error ? error.message : String(error),
              "gen_ai.tool.name": toolName,
            },
            "Failed to deliver tool call event to stream coordinator",
          );
        });
      },
    };
    const baseAgentTools = createAgentTools(
      tools as Record<string, ToolDefinition<any>>,
      skillSandbox,
      spanContext,
      context.onStatus,
      sandboxExecutor,
      capabilityRuntime,
      pluginAuth,
      agentToolHooks,
    );

    // Mutable tools array shared with the agent. Pi-agent-core does not clone
    // this reference, so in-place mutations are visible to the running loop.
    const agentTools: AgentTool[] = [...baseAgentTools];

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
        pluginAuth,
        agentToolHooks,
      );
      agentTools.length = 0;
      agentTools.push(...baseAgentTools, ...mcpAgentTools);
    };

    syncMcpAgentTools();

    // ── Agent execution ──────────────────────────────────────────────
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
      if (event.type === "message_start") {
        Promise.resolve(context.onAssistantMessageStart?.()).catch((error) => {
          logWarn(
            "streaming_message_start_error",
            {},
            {
              "error.message":
                error instanceof Error ? error.message : String(error),
            },
            "Failed to deliver assistant message start to stream coordinator",
          );
        });
        if (hasEmittedText) {
          needsSeparator = true;
        }
        return;
      }
      if (event.type !== "message_update") return;
      if (event.assistantMessageEvent.type !== "text_delta") return;
      const deltaText = event.assistantMessageEvent.delta;
      if (!deltaText) return;

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
    let newMessages: AgentMessage[] = [];
    let completedAssistantTurn = false;

    try {
      if (resumedFromCheckpoint) {
        agent.replaceMessages(existingCheckpoint!.piMessages);
      }
      beforeMessageCount = agent.state.messages.length;

      await withSpan(
        "ai.generate_assistant_reply",
        "gen_ai.invoke_agent",
        spanContext,
        async () => {
          let promptResult: unknown;
          const promptPromise = resumedFromCheckpoint
            ? // Checkpoint resumes continue from the persisted Pi message
              // state. Any reconstructed replyContext only matters when the
              // turn parked before the initial user prompt was recorded.
              agent.continue()
            : agent.prompt({
                role: "user",
                content: userContentParts,
                timestamp: Date.now(),
              });

          let timeoutId: ReturnType<typeof setTimeout> | undefined;
          const timeoutPromise = new Promise<never>((_, reject) => {
            timeoutId = setTimeout(() => {
              timedOut = true;
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
            if (timedOut) {
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
              // Wait for promptPromise to settle before snapshotting messages
              // — the agent loop may still be mutating state.
              await promptPromise.catch(() => {});
              timeoutResumeMessages = [...agent.state.messages];
            }
            if (getPendingAuthPause()) {
              timeoutResumeMessages = [...agent.state.messages];
              throw getPendingAuthPause()!;
            }
            throw error;
          } finally {
            if (timeoutId) {
              clearTimeout(timeoutId);
            }
          }

          newMessages = agent.state.messages.slice(beforeMessageCount);
          completedAssistantTurn = hasCompletedAssistantTurn(newMessages);
          if (getPendingAuthPause() && !completedAssistantTurn) {
            timeoutResumeMessages = [...agent.state.messages];
            throw getPendingAuthPause()!;
          }
          const outputMessages = newMessages.filter(isAssistantMessage);
          const outputMessagesAttribute =
            serializeGenAiAttribute(outputMessages);
          const usageSummary = extractGenAiUsageSummary(
            promptResult,
            agent.state,
            ...outputMessages,
          );
          turnUsage = Object.values(usageSummary).some(
            (value) => value !== undefined,
          )
            ? usageSummary
            : undefined;
          setSpanAttributes({
            ...(outputMessagesAttribute
              ? { "gen_ai.output.messages": outputMessagesAttribute }
              : {}),
            ...(usageSummary.inputTokens !== undefined
              ? { "gen_ai.usage.input_tokens": usageSummary.inputTokens }
              : {}),
            ...(usageSummary.outputTokens !== undefined
              ? { "gen_ai.usage.output_tokens": usageSummary.outputTokens }
              : {}),
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

    if (getPendingAuthPause() && !completedAssistantTurn) {
      throw getPendingAuthPause()!;
    }

    // ── Persist completed checkpoint ─────────────────────────────────
    if (
      checkpointState.canUseTurnSession &&
      sessionConversationId &&
      sessionId
    ) {
      await persistCompletedCheckpoint({
        conversationId: sessionConversationId,
        sessionId,
        sliceId: currentSliceId,
        allMessages: agent.state.messages,
        loadedSkillNames: activeSkills.map((skill) => skill.name),
      });
    }

    // ── Build turn result ────────────────────────────────────────────
    return buildTurnResult({
      newMessages,
      userInput,
      replyFiles,
      artifactStatePatch,
      toolCalls,
      sandboxId: currentSandboxExecutor.getSandboxId(),
      sandboxDependencyProfileHash:
        currentSandboxExecutor.getDependencyProfileHash(),
      durationMs: Date.now() - replyStartedAtMs,
      generatedFileCount: generatedFiles.length,
      shouldTrace,
      spanContext,
      usage: turnUsage,
      correlation: context.correlation,
      assistantUserName: context.assistant?.userName,
    });
  } catch (error) {
    if (timedOut && timeoutResumeConversationId && timeoutResumeSessionId) {
      const checkpoint = await persistTimeoutCheckpoint({
        conversationId: timeoutResumeConversationId,
        sessionId: timeoutResumeSessionId,
        currentSliceId: timeoutResumeSliceId,
        messages: timeoutResumeMessages,
        loadedSkillNames: loadedSkillNamesForResume,
        errorMessage: error instanceof Error ? error.message : String(error),
        logContext: {
          threadId: context.correlation?.threadId,
          requesterId: context.correlation?.requesterId,
          channelId: context.correlation?.channelId,
          runId: context.correlation?.runId,
          assistantUserName: context.assistant?.userName,
          modelId: botConfig.modelId,
        },
      });
      if (checkpoint) {
        throw new RetryableTurnError(
          "turn_timeout_resume",
          `conversation=${timeoutResumeConversationId} session=${timeoutResumeSessionId} slice=${checkpoint.sliceId} version=${checkpoint.checkpointVersion}`,
          {
            conversationId: timeoutResumeConversationId,
            sessionId: timeoutResumeSessionId,
            sliceId: checkpoint.sliceId,
            checkpointVersion: checkpoint.checkpointVersion,
          },
        );
      }
    }

    // ── MCP auth pause → checkpoint and retry ────────────────────────
    if (
      (error instanceof McpAuthorizationPauseError ||
        error instanceof PluginAuthorizationPauseError) &&
      timeoutResumeConversationId &&
      timeoutResumeSessionId
    ) {
      const nextSliceId = await persistAuthPauseCheckpoint({
        conversationId: timeoutResumeConversationId,
        sessionId: timeoutResumeSessionId,
        currentSliceId: timeoutResumeSliceId,
        messages: timeoutResumeMessages,
        loadedSkillNames: loadedSkillNamesForResume,
        errorMessage: error.message,
        logContext: {
          threadId: context.correlation?.threadId,
          requesterId: context.correlation?.requesterId,
          channelId: context.correlation?.channelId,
          runId: context.correlation?.runId,
          assistantUserName: context.assistant?.userName,
          modelId: botConfig.modelId,
        },
      });
      throw new RetryableTurnError(
        error instanceof PluginAuthorizationPauseError
          ? "plugin_auth_resume"
          : "mcp_auth_resume",
        `conversation=${timeoutResumeConversationId} session=${timeoutResumeSessionId} slice=${nextSliceId}`,
        {
          conversationId: timeoutResumeConversationId,
          sessionId: timeoutResumeSessionId,
          sliceId: nextSliceId,
        },
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
      ...getSandboxMetadata(),
      diagnostics: {
        outcome: "provider_error",
        modelId: botConfig.modelId,
        assistantMessageCount: 0,
        toolCalls: [],
        toolResultCount: 0,
        toolErrorCount: 0,
        usedPrimaryText: false,
        durationMs: Date.now() - replyStartedAtMs,
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
