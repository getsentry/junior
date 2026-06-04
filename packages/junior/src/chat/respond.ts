/**
 * Agent turn orchestration.
 *
 * This module owns the Pi-facing execution boundary for one Junior turn after
 * Slack/runtime code has normalized the request. It assembles prompt context,
 * restores durable Pi/session state, wires tools/MCP/auth, executes the agent,
 * and persists resumable checkpoints. Slack delivery and thread presentation
 * should stay outside this file.
 */
import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import { THREAD_STATE_TTL_MS, type FileUpload } from "chat";
import { botConfig } from "@/chat/config";
import {
  extractGenAiUsageAttributes,
  extractGenAiUsageSummary,
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
import { buildSystemPrompt, buildTurnContextPrompt } from "@/chat/prompt";
import { createUserTokenStore } from "@/chat/capabilities/factory";
import { maybeExecuteJrRpcCustomCommand } from "@/chat/capabilities/jr-rpc-command";
import { getConfigDefaults } from "@/chat/configuration/defaults";
import type { ChannelConfigurationService } from "@/chat/configuration/types";
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
import { createAgentPluginHookRunner } from "@/chat/plugins/agent-hooks";
import { McpToolManager } from "@/chat/mcp/tool-manager";
import {
  inferActiveMcpProvidersFromPiMessages,
  inferLoadedSkillNamesFromPiMessages,
} from "@/chat/pi/derived-state";
import type { ThreadArtifactsState } from "@/chat/state/artifacts";
import type { ConversationPendingAuthState } from "@/chat/state/conversation";
import {
  loadConnectedMcpProviders,
  recordMcpProviderConnected,
} from "@/chat/state/session-log";
import { createTools } from "@/chat/tools";
import { resolveChannelCapabilities } from "@/chat/tools/channel-capabilities";
import type { ToolDefinition } from "@/chat/tools/definition";
import { toActiveMcpCatalogSummaries } from "@/chat/tools/skill/mcp-tool-summary";
import type {
  ImageGenerateToolDeps,
  WebFetchToolDeps,
  WebSearchToolDeps,
} from "@/chat/tools/types";
import { createAdvisorToolDefinitions } from "@/chat/tools/advisor/tool";
import {
  GEN_AI_PROVIDER_NAME,
  GEN_AI_SERVER_ADDRESS,
  GEN_AI_SERVER_PORT,
  completeObject,
  getPiGatewayApiKeyOverride,
  resolveGatewayModel,
} from "@/chat/pi/client";
import type { PiMessage } from "@/chat/pi/messages";
import { createTracedStreamFn } from "@/chat/pi/traced-stream";
import {
  createSandboxExecutor,
  type SandboxAcquiredState,
  type SandboxExecutor,
} from "@/chat/sandbox/sandbox";
import type { SandboxWorkspace } from "@/chat/sandbox/workspace";
import { shouldEmitDevAgentTrace } from "@/chat/runtime/dev-agent-trace";
import type { AssistantStatusSpec } from "@/chat/slack/assistant-thread/status";
import type { SlackConversationContext } from "@/chat/slack/conversation-context";
import { createAgentTools } from "@/chat/tools/agent-tools";
import { mergeArtifactsState } from "@/chat/runtime/thread-state";
import {
  CooperativeTurnYieldError,
  RetryableTurnError,
  TurnInputCommitLostError,
  isTurnInputCommitLostError,
  isRetryableTurnError,
} from "@/chat/runtime/turn";
import {
  buildUserTurnText,
  encodeNonImageAttachmentForPrompt,
  getSessionIdentifiers,
  hasRuntimeTurnContext,
  isAssistantMessage,
  prependMissingRuntimeTurnContext,
  summarizeMessageText,
  toObservablePromptPart,
  upsertActiveSkill,
} from "@/chat/respond-helpers";
import {
  buildTurnResult,
  type AssistantReply,
  type AgentTurnDiagnostics,
} from "@/chat/services/turn-result";
import {
  isRetryableProviderError,
  trimRetryableProviderErrorTail,
} from "@/chat/services/provider-retry";
import {
  selectTurnThinkingLevel,
  toAgentThinkingLevel,
  type TurnThinkingSelection,
} from "@/chat/services/turn-thinking-level";
import {
  addAgentTurnUsage,
  hasAgentTurnUsage,
  type AgentTurnUsage,
} from "@/chat/usage";
import {
  loadTurnSessionRecord,
  persistCompletedSessionRecord,
  persistAuthPauseSessionRecord,
  persistRunningSessionRecord,
  persistTimeoutSessionRecord,
  persistYieldSessionRecord,
} from "@/chat/services/turn-session-record";
import type { AgentTurnRequester } from "@/chat/state/turn-session";
import type { CredentialContext } from "@/chat/credentials/context";
import { createMcpAuthOrchestration } from "@/chat/services/mcp-auth-orchestration";
import { createPluginAuthOrchestration } from "@/chat/services/plugin-auth-orchestration";
import {
  AuthorizationFlowDisabledError,
  AuthorizationPauseError,
  type AuthorizationFlowMode,
} from "@/chat/services/auth-pause";
import {
  resolveConversationPrivacy,
  toGenAiMessageMetadata,
  toGenAiMessagesTraceAttributes,
} from "@/chat/conversation-privacy";

// Re-export types for backward compatibility with existing consumers.
export type { AssistantReply, AgentTurnDiagnostics };

const PROVIDER_RETRY_DELAYS_MS = [1_000, 2_000] as const;
const AGENT_ABORT_SETTLE_GRACE_MS = 5_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Bound post-abort waiting so timeout recovery can persist before the host kills the slice. */
function waitForAbortSettlement(
  promise: Promise<unknown>,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const timeoutId = setTimeout(() => {
      if (!done) {
        done = true;
        resolve(false);
      }
    }, timeoutMs);
    timeoutId.unref?.();

    promise.then(
      () => {
        if (!done) {
          done = true;
          clearTimeout(timeoutId);
          resolve(true);
        }
      },
      () => {
        if (!done) {
          done = true;
          clearTimeout(timeoutId);
          resolve(true);
        }
      },
    );
  });
}

export interface ReplyRequestContext {
  skillDirs?: string[];
  credentialContext?: CredentialContext;
  requester?: {
    userId?: string;
    userName?: string;
    fullName?: string;
    email?: string;
  };
  slackConversation?: SlackConversationContext;
  correlation?: {
    conversationId?: string;
    threadId?: string;
    turnId?: string;
    runId?: string;
    channelId?: string;
    channelName?: string;
    teamId?: string;
    messageTs?: string;
    threadTs?: string;
    requesterId?: string;
  };
  toolChannelId?: string;
  conversationContext?: string;
  artifactState?: ThreadArtifactsState;
  pendingAuth?: ConversationPendingAuthState;
  authorizationFlowMode?: AuthorizationFlowMode;
  configuration?: Record<string, unknown>;
  /** Durable Pi transcript for this conversation, excluding ephemeral turn context. */
  piMessages?: PiMessage[];
  /** Absolute wall-clock deadline for this host request, in milliseconds. */
  turnDeadlineAtMs?: number;
  channelConfiguration?: ChannelConfigurationService;
  userAttachments?: ReplyRequestAttachment[];
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
  onInputCommitted?: () => void | Promise<void>;
  toolOverrides?: {
    imageGenerate?: ImageGenerateToolDeps;
    webFetch?: WebFetchToolDeps;
    webSearch?: WebSearchToolDeps;
  };
  onStatus?: (status: AssistantStatusSpec) => void | Promise<void>;
  drainSteeringMessages?: (
    inject: (messages: ReplySteeringMessage[]) => Promise<void>,
  ) => Promise<ReplySteeringMessage[]>;
  /** Return true when the durable worker should pause at the next Pi boundary. */
  shouldYield?: () => boolean;
  onAuthPending?: (
    pendingAuth: ConversationPendingAuthState,
  ) => void | Promise<void>;
  onTextDelta?: (deltaText: string) => void | Promise<void>;
  onAssistantMessageStart?: () => void | Promise<void>;
  onToolInvocation?: (invocation: {
    toolName: string;
    params: Record<string, unknown>;
  }) => void;
}

export interface ReplyRequestAttachment {
  data?: Buffer;
  mediaType: string;
  filename?: string;
  promptText?: string;
}

export interface ReplySteeringMessage {
  omittedImageAttachmentCount?: number;
  text: string;
  timestampMs?: number;
  userAttachments?: ReplyRequestAttachment[];
}

let startupDiscoveryLogged = false;
const MAX_ROUTER_ATTACHMENT_PREVIEW_CHARS = 2_000;

type UserTurnContentPart =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

type UserTurnAttachment = NonNullable<
  ReplyRequestContext["userAttachments"]
>[number];

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

function trimRouterAttachmentText(text: string): string {
  const normalized = text.replaceAll("\0", " ").trim();
  if (!normalized) {
    return "";
  }
  return normalized.length <= MAX_ROUTER_ATTACHMENT_PREVIEW_CHARS
    ? normalized
    : `${normalized.slice(0, MAX_ROUTER_ATTACHMENT_PREVIEW_CHARS)}...`;
}

function extractSliceUsage(
  messages: PiMessage[],
  beforeMessageCount: number,
): AgentTurnUsage | undefined {
  const usage = extractGenAiUsageSummary(
    ...messages.slice(beforeMessageCount).filter(isAssistantMessage),
  );
  return hasAgentTurnUsage(usage) ? usage : undefined;
}

function requesterFromContext(
  requester: ReplyRequestContext["requester"],
  requesterId: string | undefined,
): AgentTurnRequester | undefined {
  const identity: AgentTurnRequester = {
    ...(requester?.email ? { email: requester.email } : {}),
    ...(requester?.fullName ? { fullName: requester.fullName } : {}),
    ...((requesterId ?? requester?.userId)
      ? { slackUserId: requesterId ?? requester?.userId }
      : {}),
    ...(requester?.userName ? { slackUserName: requester.userName } : {}),
  };
  return Object.keys(identity).length > 0 ? identity : undefined;
}

function supportsRouterTextPreview(mediaType: string): boolean {
  const baseMediaType = mediaType.split(";", 1)[0]?.trim().toLowerCase();
  if (!baseMediaType) {
    return false;
  }
  return (
    baseMediaType.startsWith("text/") ||
    baseMediaType === "application/json" ||
    baseMediaType === "application/xml" ||
    baseMediaType === "application/x-www-form-urlencoded" ||
    baseMediaType.endsWith("+json") ||
    baseMediaType.endsWith("+xml")
  );
}

function buildRouterAttachmentBlock(attachment: UserTurnAttachment): string {
  if (attachment.promptText) {
    return trimRouterAttachmentText(attachment.promptText);
  }

  const header = [
    "<attachment>",
    `filename: ${attachment.filename ?? "unnamed"}`,
    `media_type: ${attachment.mediaType}`,
  ];

  if (attachment.data && supportsRouterTextPreview(attachment.mediaType)) {
    const preview = trimRouterAttachmentText(attachment.data.toString("utf8"));
    if (preview) {
      return [
        ...header,
        "<text-preview>",
        preview,
        "</text-preview>",
        "</attachment>",
      ].join("\n");
    }
  }

  return [...header, "</attachment>"].join("\n");
}

function buildUserTurnInput(args: {
  omittedImageAttachmentCount: number;
  userAttachments?: ReplyRequestContext["userAttachments"];
  userTurnText: string;
}): {
  routerBlocks: string[];
  userContentParts: UserTurnContentPart[];
} {
  const routerBlocks: string[] = [];
  const userContentParts: UserTurnContentPart[] = [
    { type: "text", text: args.userTurnText },
  ];

  if (args.omittedImageAttachmentCount > 0) {
    const omittedImagesNotice = buildOmittedImageAttachmentNotice(
      args.omittedImageAttachmentCount,
    );
    userContentParts.push({ type: "text", text: omittedImagesNotice });
    routerBlocks.push(omittedImagesNotice);
  }

  for (const attachment of args.userAttachments ?? []) {
    routerBlocks.push(buildRouterAttachmentBlock(attachment));

    if (attachment.promptText) {
      userContentParts.push({
        type: "text",
        text: attachment.promptText,
      });
      continue;
    }

    if (attachment.mediaType.startsWith("image/")) {
      if (!attachment.data) {
        throw new Error("Image attachment is missing image data");
      }
      userContentParts.push({
        type: "image",
        data: attachment.data.toString("base64"),
        mimeType: attachment.mediaType,
      });
      continue;
    }

    if (!attachment.data) {
      throw new Error("Attachment is missing attachment data");
    }

    userContentParts.push({
      type: "text",
      text: encodeNonImageAttachmentForPrompt({
        data: attachment.data,
        mediaType: attachment.mediaType,
        filename: attachment.filename,
      }),
    });
  }

  return { routerBlocks, userContentParts };
}

function buildSteeringPiMessage(message: ReplySteeringMessage): PiMessage {
  const { userContentParts } = buildUserTurnInput({
    userTurnText: message.text,
    userAttachments: message.userAttachments,
    omittedImageAttachmentCount: message.omittedImageAttachmentCount ?? 0,
  });
  return {
    role: "user",
    content: userContentParts,
    timestamp: message.timestampMs ?? Date.now(),
  } as PiMessage;
}

/** Run a full agent turn: discover skills, execute tools, and return the assistant reply. */
export async function generateAssistantReply(
  messageText: string,
  context: ReplyRequestContext = {},
): Promise<AssistantReply> {
  const replyStartedAtMs = Date.now();
  const configuredTurnDeadlineAtMs = replyStartedAtMs + botConfig.turnTimeoutMs;
  const contextTurnDeadlineAtMs =
    typeof context.turnDeadlineAtMs === "number" &&
    Number.isFinite(context.turnDeadlineAtMs)
      ? Math.floor(context.turnDeadlineAtMs)
      : undefined;
  const turnDeadlineAtMs =
    contextTurnDeadlineAtMs === undefined
      ? configuredTurnDeadlineAtMs
      : Math.min(configuredTurnDeadlineAtMs, contextTurnDeadlineAtMs);
  const turnTimeoutBudgetMs = Math.max(0, turnDeadlineAtMs - replyStartedAtMs);
  let timeoutResumeConversationId: string | undefined;
  let timeoutResumeSessionId: string | undefined;
  let timeoutResumeSliceId = 1;
  let timeoutResumeMessages: PiMessage[] = [];
  let beforeMessageCount = 0;
  let lastKnownSandboxId: string | undefined = context.sandbox?.sandboxId;
  let lastKnownSandboxDependencyProfileHash: string | undefined =
    context.sandbox?.sandboxDependencyProfileHash;
  let loadedSkillNamesForResume: string[] = [];
  let mcpToolManager: McpToolManager | undefined;
  let connectedMcpProviders = new Set<string>();
  let canRecordMcpProviders = false;
  let sandboxExecutor: SandboxExecutor | undefined;
  let timedOut = false;
  let cooperativeYieldError: CooperativeTurnYieldError | undefined;
  let inputCommitted = false;
  let turnUsage: AgentTurnUsage | undefined;
  let thinkingSelection: TurnThinkingSelection | undefined;
  const requester = requesterFromContext(
    context.requester,
    context.correlation?.requesterId,
  );
  const credentialActor = context.credentialContext?.actor;
  const credentialActorLogContext = credentialActor
    ? {
        actorType: credentialActor.type,
        actorId:
          credentialActor.type === "user"
            ? credentialActor.userId
            : credentialActor.id,
      }
    : {};
  const conversationPrivacy = resolveConversationPrivacy({
    channelId: context.correlation?.channelId,
    conversationId:
      context.correlation?.conversationId ??
      context.correlation?.threadId ??
      context.correlation?.runId,
  });
  const sessionRecordLogContext = {
    threadId: context.correlation?.threadId,
    requesterId: context.correlation?.requesterId,
    channelId: context.correlation?.channelId,
    runId: context.correlation?.runId,
    ...credentialActorLogContext,
    assistantUserName: botConfig.userName,
    modelId: botConfig.modelId,
  };
  const recordConnectedMcpProvider = async (provider: string) => {
    if (
      !canRecordMcpProviders ||
      !timeoutResumeConversationId ||
      connectedMcpProviders.has(provider)
    ) {
      return;
    }
    await recordMcpProviderConnected({
      conversationId: timeoutResumeConversationId,
      provider,
      ttlMs: THREAD_STATE_TTL_MS,
    });
    connectedMcpProviders.add(provider);
  };
  const recordActiveMcpProviders = async () => {
    if (!mcpToolManager) {
      return;
    }
    for (const provider of mcpToolManager.getActiveProviders()) {
      await recordConnectedMcpProvider(provider);
    }
  };

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
      slackThreadId: context.correlation?.threadId,
      slackUserId: context.correlation?.requesterId,
      slackChannelId: context.correlation?.channelId,
      runId: context.correlation?.runId,
      ...credentialActorLogContext,
      assistantUserName: botConfig.userName,
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
          "app.file.directories": roots,
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
    const syncLoadedSkillNamesForResume = () => {
      loadedSkillNamesForResume = activeSkills.map((skill) => skill.name);
    };
    const skillSandbox = new SkillSandbox(availableSkills, activeSkills);

    // ── Turn Session Record ────────────────────────────────────────
    const { conversationId: sessionConversationId, sessionId } =
      getSessionIdentifiers(context);
    const turnSessionState = await loadTurnSessionRecord({
      conversationId: sessionConversationId,
      sessionId,
    });
    const { resumedFromSessionRecord, currentSliceId, existingSessionRecord } =
      turnSessionState;
    timeoutResumeConversationId = sessionConversationId;
    timeoutResumeSessionId = sessionId;
    timeoutResumeSliceId = currentSliceId;
    canRecordMcpProviders = Boolean(
      turnSessionState.canUseTurnSession && sessionConversationId && sessionId,
    );
    const persistedConfigurationValues = context.channelConfiguration
      ? await context.channelConfiguration.resolveValues()
      : {};
    configurationValues = {
      ...getConfigDefaults(),
      ...(context.configuration ?? {}),
      ...persistedConfigurationValues,
    };
    // ── Sandbox ──────────────────────────────────────────────────────
    const authRequesterId =
      context.credentialContext?.actor.type === "user"
        ? context.credentialContext.actor.userId
        : undefined;
    const userTokenStore = createUserTokenStore();
    const agentPluginHooks = createAgentPluginHookRunner({
      requester: context.requester,
    });
    sandboxExecutor = createSandboxExecutor({
      sandboxId: context.sandbox?.sandboxId,
      sandboxDependencyProfileHash:
        context.sandbox?.sandboxDependencyProfileHash,
      traceContext: spanContext,
      credentialEgress: context.credentialContext,
      agentHooks: agentPluginHooks,
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
    // Match the history source the agent will actually receive so crash retries
    // do not let an unstripped running record suppress fresh turn context.
    const priorPiMessages = resumedFromSessionRecord
      ? existingSessionRecord?.piMessages
      : context.piMessages;
    connectedMcpProviders = new Set(
      turnSessionState.canUseTurnSession && sessionConversationId
        ? await loadConnectedMcpProviders({
            conversationId: sessionConversationId,
          })
        : [],
    );
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

    // ── Restore skill runtime handles from durable Pi history ────────
    for (const skillName of inferLoadedSkillNamesFromPiMessages(
      priorPiMessages,
    )) {
      const restoredSkill = await skillSandbox.loadSkill(skillName);
      if (restoredSkill) {
        upsertActiveSkill(activeSkills, restoredSkill);
        syncLoadedSkillNamesForResume();
      }
    }
    if (invokedSkill) {
      const restoredSkill = await skillSandbox.loadSkill(invokedSkill.name);
      if (restoredSkill) {
        upsertActiveSkill(activeSkills, restoredSkill);
        syncLoadedSkillNamesForResume();
      }
    }

    const promptConversationContext =
      context.piMessages && context.piMessages.length > 0
        ? undefined
        : context.conversationContext;
    const userTurnText = buildUserTurnText(
      userInput,
      promptConversationContext,
    );
    const { routerBlocks, userContentParts } = buildUserTurnInput({
      omittedImageAttachmentCount: context.omittedImageAttachmentCount ?? 0,
      userAttachments: context.userAttachments,
      userTurnText,
    });
    const preAgentPromptMessages = (): PiMessage[] =>
      existingSessionRecord?.piMessages ?? [
        ...(context.piMessages ?? []),
        {
          role: "user",
          content: userContentParts,
          timestamp: Date.now(),
        } as PiMessage,
      ];

    thinkingSelection = await selectTurnThinkingLevel({
      completeObject,
      conversationContext: context.conversationContext,
      context: {
        threadId: context.correlation?.threadId,
        channelId: context.correlation?.channelId,
        requesterId: context.correlation?.requesterId,
        runId: context.correlation?.runId,
      },
      currentTurnBlocks: routerBlocks,
      fastModelId: botConfig.fastModelId,
      messageText: userInput,
    });
    setSpanAttributes({
      "gen_ai.request.model": botConfig.modelId,
      "app.ai.reasoning_effort": thinkingSelection.thinkingLevel,
      "app.ai.thinking_level_reason": thinkingSelection.reason,
      ...(thinkingSelection.confidence !== undefined
        ? {
            "app.ai.thinking_level_confidence": thinkingSelection.confidence,
          }
        : {}),
    });

    // ── Mutable turn state ───────────────────────────────────────────
    timeoutResumeMessages = [];
    const generatedFiles: FileUpload[] = [];
    const replyFiles: FileUpload[] = [];
    const artifactStatePatch: Partial<ThreadArtifactsState> = {};
    const toolCalls: string[] = [];
    let advisorTools: AgentTool[] = [];
    let agent: Agent | undefined;
    let latestSafeBoundaryMessages: PiMessage[] = [];
    const getResumeSnapshot = (): PiMessage[] => {
      const currentMessages = agent ? [...agent.state.messages] : [];
      return latestSafeBoundaryMessages.length > currentMessages.length
        ? [...latestSafeBoundaryMessages]
        : currentMessages;
    };

    // ── MCP auth orchestration ───────────────────────────────────────
    const mcpAuth = createMcpAuthOrchestration(
      {
        conversationId: sessionConversationId,
        sessionId,
        requesterId: authRequesterId,
        channelId: context.correlation?.channelId,
        threadTs: context.correlation?.threadTs,
        toolChannelId: context.toolChannelId,
        userMessage: userInput,
        currentPendingAuth: context.pendingAuth,
        getConfiguration: () => configurationValues,
        getArtifactState: () => context.artifactState,
        getMergedArtifactState: () =>
          mergeArtifactsState(context.artifactState ?? {}, artifactStatePatch),
        onPendingAuth: context.onAuthPending,
        authorizationFlowMode: context.authorizationFlowMode,
      },
      () => agent?.abort(),
    );
    const pluginAuth = createPluginAuthOrchestration(
      {
        conversationId: sessionConversationId,
        sessionId,
        requesterId: authRequesterId,
        channelId: context.correlation?.channelId,
        threadTs: context.correlation?.threadTs,
        userMessage: userInput,
        channelConfiguration: context.channelConfiguration,
        currentPendingAuth: context.pendingAuth,
        onPendingAuth: context.onAuthPending,
        authorizationFlowMode: context.authorizationFlowMode,
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
    setTags({
      conversationId: spanContext.conversationId,
      slackThreadId: context.correlation?.threadId,
      slackUserId: context.correlation?.requesterId,
      slackChannelId: context.correlation?.channelId,
      runId: context.correlation?.runId,
      ...credentialActorLogContext,
      assistantUserName: botConfig.userName,
      modelId: botConfig.modelId,
    });

    // ── Tool creation ────────────────────────────────────────────────
    const toolChannelId =
      context.toolChannelId ?? context.correlation?.channelId;
    const channelCapabilities = resolveChannelCapabilities(toolChannelId);
    const loadableSkills = availableSkills.filter(
      (skill) =>
        skill.disableModelInvocation !== true ||
        skill.name === invokedSkill?.name,
    );
    const tools = createTools(
      loadableSkills,
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
          syncLoadedSkillNamesForResume();
          if (await turnMcpToolManager.activateForSkill(effective)) {
            await recordConnectedMcpProvider(effective.pluginProvider!);
          }
          if (mcpAuth.getPendingPause()) {
            // Auth pause requested — suppress loadSkill failure and let the
            // aborted turn park cleanly.
            return undefined;
          }
          if (!effective.pluginProvider) {
            return undefined;
          }
          if (
            !turnMcpToolManager
              .getActiveProviders()
              .includes(effective.pluginProvider)
          ) {
            return undefined;
          }
          const availableToolCount = turnMcpToolManager.getActiveToolCatalog({
            provider: effective.pluginProvider,
          }).length;
          return {
            mcp_provider: effective.pluginProvider,
            available_tool_count: availableToolCount,
          };
        },
      },
      {
        channelId: toolChannelId,
        channelCapabilities,
        requester: context.requester,
        teamId: context.correlation?.teamId,
        messageTs: context.correlation?.messageTs,
        threadTs: context.correlation?.threadTs,
        userText: userInput,
        artifactState: context.artifactState,
        configuration: configurationValues,
        mcpToolManager: turnMcpToolManager,
        sandbox,
        advisor: {
          config: botConfig.advisor,
          conversationId: sessionConversationId,
          conversationPrivacy,
          logContext: spanContext,
          getTools: () => advisorTools,
          streamFn: createTracedStreamFn({ conversationPrivacy }),
        },
      },
    );

    const toolGuidance = Object.entries(
      tools as Record<string, ToolDefinition<any>>,
    ).map(([name, definition]) => ({
      name,
      promptGuidelines: definition.promptGuidelines,
      promptSnippet: definition.promptSnippet,
    }));

    // ── MCP provider activation ──────────────────────────────────────
    // Restore providers visible in durable Pi session history. In serverless
    // runtimes, later slices and follow-up turns usually run in a fresh
    // process, so in-memory MCP clients cannot be reused.
    const providersToRestore = new Set([
      ...connectedMcpProviders,
      ...inferActiveMcpProvidersFromPiMessages(priorPiMessages),
    ]);
    for (const provider of providersToRestore) {
      if (await turnMcpToolManager.activateProvider(provider)) {
        await recordConnectedMcpProvider(provider);
      }
      if (mcpAuth.getPendingPause()) {
        timeoutResumeMessages = preAgentPromptMessages();
        throw mcpAuth.getPendingPause()!;
      }
    }
    // Activate MCP for skills recovered from durable Pi history.
    for (const skill of activeSkills) {
      if (await turnMcpToolManager.activateForSkill(skill)) {
        await recordConnectedMcpProvider(skill.pluginProvider!);
      }
      if (mcpAuth.getPendingPause()) {
        timeoutResumeMessages = preAgentPromptMessages();
        throw mcpAuth.getPendingPause()!;
      }
    }

    // ── Prompt context ───────────────────────────────────────────────
    const activeMcpCatalogs = toActiveMcpCatalogSummaries(
      turnMcpToolManager.getActiveToolCatalog(),
    );
    baseInstructions = buildSystemPrompt();
    const needsBootstrapContext = !hasRuntimeTurnContext(priorPiMessages ?? []);
    const turnContextPrompt = needsBootstrapContext
      ? buildTurnContextPrompt({
          availableSkills,
          activeMcpCatalogs,
          includeSessionContext: true,
          toolGuidance,
          runtime: {
            conversationId: spanContext.conversationId,
            slackConversation: context.slackConversation,
          },
          invocation: skillInvocation,
          requester: context.requester,
          artifactState: context.artifactState,
          configuration: configurationValues,
        })
      : null;
    const turnContextParts: UserTurnContentPart[] = turnContextPrompt
      ? [{ type: "text", text: turnContextPrompt }]
      : [];
    const promptContentParts: UserTurnContentPart[] = [
      ...turnContextParts,
      ...userContentParts,
    ];

    const inputMessages = [
      {
        role: "system",
        content: [{ type: "text", text: baseInstructions }],
      },
      {
        role: "user",
        content: promptContentParts.map((part) => toObservablePromptPart(part)),
      },
    ];
    const inputMessagesAttribute = serializeGenAiAttribute(
      conversationPrivacy !== "public"
        ? inputMessages.map(toGenAiMessageMetadata)
        : inputMessages,
    );

    // ── Agent tools ──────────────────────────────────────────────────
    const onToolCall = (toolName: string, params: Record<string, unknown>) => {
      toolCalls.push(toolName);
      try {
        context.onToolInvocation?.({ toolName, params });
      } catch (error) {
        logWarn(
          "tool_invocation_observer_failed",
          spanContext,
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
      skillSandbox,
      spanContext,
      context.onStatus,
      sandboxExecutor,
      pluginAuth,
      onToolCall,
      agentPluginHooks,
      conversationPrivacy,
    );
    advisorTools = createAgentTools(
      createAdvisorToolDefinitions(tools),
      skillSandbox,
      spanContext,
      context.onStatus,
      sandboxExecutor,
      pluginAuth,
      onToolCall,
      agentPluginHooks,
      conversationPrivacy,
    );
    // Keep Pi's native tool schema static for the whole turn. Ideally this
    // would use provider-native tool loading/search APIs, but Pi's generic
    // AgentTool surface cannot yet express OpenAI/Anthropic deferred MCP tools.
    // Until it can, MCP tools are searched/disclosed as data and executed
    // through callMcpTool so provider cache/session affinity never sees a
    // mid-run native tool-list mutation.

    // ── Agent execution ──────────────────────────────────────────────
    let hasEmittedText = false;
    let needsSeparator = false;
    const commitInput = async (): Promise<void> => {
      if (inputCommitted) {
        return;
      }
      await context.onInputCommitted?.();
      inputCommitted = true;
    };
    const persistSafeBoundary = async (
      messages: PiMessage[],
    ): Promise<boolean> => {
      if (
        !turnSessionState.canUseTurnSession ||
        !sessionConversationId ||
        !sessionId
      ) {
        return false;
      }

      const persisted = await persistRunningSessionRecord({
        channelName: context.correlation?.channelName,
        conversationId: sessionConversationId,
        sessionId,
        sliceId: currentSliceId,
        messages,
        loadedSkillNames: loadedSkillNamesForResume,
        logContext: sessionRecordLogContext,
        requester,
      });
      if (!persisted) {
        return false;
      }

      latestSafeBoundaryMessages = [...messages];
      return true;
    };
    const requireDurableInputCheckpoint = async (
      messages: PiMessage[],
    ): Promise<boolean> => {
      const persisted = await persistSafeBoundary(messages);
      if (!persisted && context.onInputCommitted) {
        throw new TurnInputCommitLostError(
          `Durable turn input could not be checkpointed for conversation=${sessionConversationId ?? "unknown"} session=${sessionId ?? "unknown"}`,
        );
      }
      return persisted;
    };
    const drainSteeringMessages = async (): Promise<void> => {
      if (
        !context.drainSteeringMessages ||
        !turnSessionState.canUseTurnSession ||
        !sessionConversationId ||
        !sessionId
      ) {
        return;
      }

      try {
        let steeredMessageCount = 0;
        await context.drainSteeringMessages(async (messages) => {
          const piMessages = messages.map(buildSteeringPiMessage);
          if (piMessages.length === 0) {
            return;
          }
          await requireDurableInputCheckpoint([
            ...agent!.state.messages,
            ...piMessages,
          ]);
          for (const message of piMessages) {
            agent!.steer(message);
          }
          steeredMessageCount += piMessages.length;
        });
        if (steeredMessageCount > 0) {
          logInfo(
            "agent_turn_steering_messages_injected",
            spanContext,
            {
              "app.ai.steering_message_count": steeredMessageCount,
            },
            "Agent turn steering messages injected",
          );
        }
      } catch (error) {
        if (isTurnInputCommitLostError(error)) {
          throw error;
        }
        logWarn(
          "agent_turn_steering_messages_drain_failed",
          spanContext,
          {
            "exception.message":
              error instanceof Error ? error.message : String(error),
          },
          "Agent turn steering message drain failed",
        );
      }
    };
    const yieldAtSafeBoundaryIfDue = (): void => {
      if (!context.shouldYield?.()) {
        return;
      }

      timeoutResumeMessages = getResumeSnapshot();
      cooperativeYieldError = new CooperativeTurnYieldError(
        `Agent turn yielded at a safe boundary after ${
          Date.now() - replyStartedAtMs
        }ms`,
      );
      throw cooperativeYieldError;
    };

    agent = new Agent({
      getApiKey: () => getPiGatewayApiKeyOverride(),
      streamFn: createTracedStreamFn({ conversationPrivacy }),
      steeringMode: "all",
      prepareNextTurn: async () => {
        await drainSteeringMessages();
        yieldAtSafeBoundaryIfDue();
        return undefined;
      },
      initialState: {
        systemPrompt: baseInstructions,
        model: resolveGatewayModel(botConfig.modelId),
        thinkingLevel: toAgentThinkingLevel(thinkingSelection.thinkingLevel),
        tools: agentTools,
      },
    });

    const unsubscribe = agent.subscribe((event) => {
      if (event.type === "turn_end" && event.toolResults.length > 0) {
        return persistSafeBoundary([...agent!.state.messages]).then(
          () => undefined,
        );
      }
      if (event.type === "message_start") {
        Promise.resolve(context.onAssistantMessageStart?.()).catch((error) => {
          logWarn(
            "streaming_message_start_error",
            {},
            {
              "exception.message":
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
            "exception.message":
              error instanceof Error ? error.message : String(error),
          },
          "Failed to deliver text delta to stream",
        );
      });
    });

    let newMessages: PiMessage[] = [];
    beforeMessageCount = agent.state.messages.length;
    try {
      if (resumedFromSessionRecord) {
        agent.state.messages = turnContextPrompt
          ? prependMissingRuntimeTurnContext(
              existingSessionRecord!.piMessages,
              turnContextPrompt,
            )
          : existingSessionRecord!.piMessages;
      } else if (context.piMessages && context.piMessages.length > 0) {
        agent.state.messages = [...context.piMessages];
      }
      beforeMessageCount = agent.state.messages.length;

      await withSpan(
        `invoke_agent ${botConfig.modelId}`,
        "gen_ai.invoke_agent",
        spanContext,
        async () => {
          let promptResult: unknown;
          const freshPromptMessage: PiMessage = {
            role: "user",
            content: promptContentParts,
            timestamp: Date.now(),
          } as PiMessage;
          if (!resumedFromSessionRecord) {
            const promptPersisted = await requireDurableInputCheckpoint([
              ...agent.state.messages,
              freshPromptMessage,
            ]);
            if (promptPersisted) {
              await commitInput();
            }
          }

          const runAgentStep = async (
            run: Promise<unknown>,
          ): Promise<unknown> => {
            let timeoutId: ReturnType<typeof setTimeout> | undefined;
            const timeoutPromise = new Promise<never>((_, reject) => {
              const rejectWithTimeout = () => {
                timedOut = true;
                agent.abort();
                reject(
                  new Error(
                    `Agent turn timed out after ${turnTimeoutBudgetMs}ms`,
                  ),
                );
              };
              const remainingTimeoutMs = turnDeadlineAtMs - Date.now();
              if (remainingTimeoutMs <= 0) {
                rejectWithTimeout();
                return;
              }
              timeoutId = setTimeout(rejectWithTimeout, remainingTimeoutMs);
            });

            try {
              return await Promise.race([run, timeoutPromise]);
            } catch (error) {
              if (timedOut) {
                logWarn(
                  "agent_turn_timeout",
                  {},
                  {
                    "gen_ai.provider.name": GEN_AI_PROVIDER_NAME,
                    "gen_ai.operation.name": "invoke_agent",
                    "gen_ai.request.model": botConfig.modelId,
                    ...(thinkingSelection
                      ? {
                          "app.ai.reasoning_effort":
                            thinkingSelection.thinkingLevel,
                        }
                      : {}),
                    "app.ai.turn_timeout_ms": turnTimeoutBudgetMs,
                    "app.ai.turn_deadline_remaining_ms": Math.max(
                      0,
                      turnDeadlineAtMs - Date.now(),
                    ),
                  },
                  "Agent turn timed out and was aborted",
                );
                const settled = await waitForAbortSettlement(
                  run,
                  AGENT_ABORT_SETTLE_GRACE_MS,
                );
                if (!settled) {
                  logWarn(
                    "agent_turn_abort_settle_timeout",
                    {},
                    {
                      "app.ai.abort_settle_grace_ms":
                        AGENT_ABORT_SETTLE_GRACE_MS,
                    },
                    "Timed-out agent run did not settle after abort before resume snapshot",
                  );
                }
                timeoutResumeMessages = getResumeSnapshot();
              }
              if (getPendingAuthPause()) {
                timeoutResumeMessages = getResumeSnapshot();
                throw getPendingAuthPause()!;
              }
              throw error;
            } finally {
              if (timeoutId) {
                clearTimeout(timeoutId);
              }
            }
          };

          let run = resumedFromSessionRecord
            ? agent.continue()
            : agent.prompt(freshPromptMessage);
          let retryUsage: AgentTurnUsage | undefined;
          for (let attempt = 0; ; attempt += 1) {
            promptResult = await runAgentStep(run);
            if (cooperativeYieldError) {
              throw cooperativeYieldError;
            }

            newMessages = agent.state.messages.slice(beforeMessageCount);
            const outputMessages = newMessages.filter(isAssistantMessage);
            const outputMessagesAttribute = serializeGenAiAttribute(
              conversationPrivacy !== "public"
                ? outputMessages.map(toGenAiMessageMetadata)
                : outputMessages,
            );
            const usageSummary = extractGenAiUsageSummary(
              promptResult,
              agent.state,
              ...outputMessages,
            );
            const currentUsage = hasAgentTurnUsage(usageSummary)
              ? usageSummary
              : undefined;
            turnUsage = addAgentTurnUsage(retryUsage, currentUsage);
            setSpanAttributes({
              ...(outputMessagesAttribute
                ? { "gen_ai.output.messages": outputMessagesAttribute }
                : {}),
              ...toGenAiMessagesTraceAttributes(
                "app.ai.output",
                outputMessages,
              ),
              ...extractGenAiUsageAttributes(usageSummary),
            });
            if (getPendingAuthPause()) {
              timeoutResumeMessages = getResumeSnapshot();
              throw getPendingAuthPause()!;
            }

            const lastAssistant = outputMessages.at(-1);
            const retryDelayMs = PROVIDER_RETRY_DELAYS_MS[attempt];
            if (
              retryDelayMs === undefined ||
              !isRetryableProviderError(lastAssistant)
            ) {
              break;
            }

            retryUsage = turnUsage;
            const retryMessages = trimRetryableProviderErrorTail(
              agent.state.messages,
            );
            if (!retryMessages) {
              break;
            }

            agent.state.messages = retryMessages;
            await persistSafeBoundary(retryMessages);
            logWarn(
              "agent_turn_provider_retry",
              spanContext,
              {},
              "Retrying transient provider failure",
            );
            await sleep(retryDelayMs);
            run = agent.continue();
          }
        },
        {
          "gen_ai.provider.name": GEN_AI_PROVIDER_NAME,
          "gen_ai.operation.name": "invoke_agent",
          "gen_ai.request.model": botConfig.modelId,
          "gen_ai.output.type": "text",
          "server.address": GEN_AI_SERVER_ADDRESS,
          "server.port": GEN_AI_SERVER_PORT,
          ...(conversationPrivacy
            ? { "app.conversation.privacy": conversationPrivacy }
            : {}),
          ...(sessionConversationId
            ? { "app.ai.session.conversation_id": sessionConversationId }
            : {}),
          ...(sessionId ? { "app.ai.turn.session_id": sessionId } : {}),
          ...(timeoutResumeSliceId
            ? { "app.ai.turn.slice_id": timeoutResumeSliceId }
            : {}),
          "app.ai.reasoning_effort": thinkingSelection.thinkingLevel,
          ...toGenAiMessagesTraceAttributes("app.ai.input", inputMessages),
          ...(inputMessagesAttribute
            ? { "gen_ai.input.messages": inputMessagesAttribute }
            : {}),
        },
      );
    } finally {
      unsubscribe();
    }

    if (
      turnSessionState.canUseTurnSession &&
      sessionConversationId &&
      sessionId
    ) {
      await recordActiveMcpProviders();
      await persistCompletedSessionRecord({
        channelName: context.correlation?.channelName,
        conversationId: sessionConversationId,
        currentDurationMs: Date.now() - replyStartedAtMs,
        currentUsage: turnUsage,
        sessionId,
        sliceId: currentSliceId,
        allMessages: agent.state.messages,
        loadedSkillNames: loadedSkillNamesForResume,
        logContext: sessionRecordLogContext,
        requester,
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
      thinkingSelection,
      correlation: context.correlation,
      assistantUserName: botConfig.userName,
    });
  } catch (error) {
    if (
      cooperativeYieldError &&
      error instanceof CooperativeTurnYieldError &&
      timeoutResumeConversationId &&
      timeoutResumeSessionId
    ) {
      turnUsage =
        turnUsage ??
        extractSliceUsage(timeoutResumeMessages, beforeMessageCount);
      await recordActiveMcpProviders();
      const sessionRecord = await persistYieldSessionRecord({
        channelName: context.correlation?.channelName,
        conversationId: timeoutResumeConversationId,
        sessionId: timeoutResumeSessionId,
        currentSliceId: timeoutResumeSliceId,
        currentDurationMs: Date.now() - replyStartedAtMs,
        currentUsage: turnUsage,
        messages: timeoutResumeMessages,
        errorMessage: error.message,
        loadedSkillNames: loadedSkillNamesForResume,
        logContext: sessionRecordLogContext,
        requester,
      });
      if (!sessionRecord) {
        throw new Error(
          `Failed to persist cooperative yield continuation for conversation=${timeoutResumeConversationId} session=${timeoutResumeSessionId}`,
        );
      }
      throw error;
    }

    if (timedOut && timeoutResumeConversationId && timeoutResumeSessionId) {
      turnUsage =
        turnUsage ??
        extractSliceUsage(timeoutResumeMessages, beforeMessageCount);
      await recordActiveMcpProviders();
      const sessionRecord = await persistTimeoutSessionRecord({
        channelName: context.correlation?.channelName,
        conversationId: timeoutResumeConversationId,
        sessionId: timeoutResumeSessionId,
        currentSliceId: timeoutResumeSliceId,
        currentDurationMs: Date.now() - replyStartedAtMs,
        currentUsage: turnUsage,
        messages: timeoutResumeMessages,
        errorMessage: error instanceof Error ? error.message : String(error),
        loadedSkillNames: loadedSkillNamesForResume,
        logContext: sessionRecordLogContext,
        requester,
      });
      if (!sessionRecord) {
        throw new Error(
          `Failed to persist timeout continuation for conversation=${timeoutResumeConversationId} session=${timeoutResumeSessionId}`,
        );
      }
      if (sessionRecord.state === "awaiting_resume") {
        throw new RetryableTurnError(
          "turn_timeout_resume",
          `conversation=${timeoutResumeConversationId} session=${timeoutResumeSessionId} slice=${sessionRecord.sliceId} version=${sessionRecord.version}`,
          {
            conversationId: timeoutResumeConversationId,
            sessionId: timeoutResumeSessionId,
            sliceId: sessionRecord.sliceId,
            version: sessionRecord.version,
          },
        );
      }
      throw new Error(
        sessionRecord.errorMessage ??
          (error instanceof Error ? error.message : String(error)),
      );
    }

    // ── MCP auth pause → session continuation ────────────────────────
    if (
      error instanceof AuthorizationPauseError &&
      timeoutResumeConversationId &&
      timeoutResumeSessionId
    ) {
      if (!turnUsage && timeoutResumeMessages.length > 0) {
        turnUsage = extractSliceUsage(
          timeoutResumeMessages,
          beforeMessageCount,
        );
      }
      await recordActiveMcpProviders();
      const sessionRecord = await persistAuthPauseSessionRecord({
        channelName: context.correlation?.channelName,
        conversationId: timeoutResumeConversationId,
        sessionId: timeoutResumeSessionId,
        currentSliceId: timeoutResumeSliceId,
        currentDurationMs: Date.now() - replyStartedAtMs,
        currentUsage: turnUsage,
        messages: timeoutResumeMessages,
        errorMessage: error.message,
        loadedSkillNames: loadedSkillNamesForResume,
        logContext: sessionRecordLogContext,
        requester,
      });
      if (sessionRecord) {
        throw new RetryableTurnError(
          error.kind === "plugin" ? "plugin_auth_resume" : "mcp_auth_resume",
          `conversation=${timeoutResumeConversationId} session=${timeoutResumeSessionId} slice=${sessionRecord.sliceId}`,
          {
            authDisposition: error.disposition,
            authDurationMs: Date.now() - replyStartedAtMs,
            authKind: error.kind,
            authProvider: error.provider,
            authThinkingLevel: thinkingSelection?.thinkingLevel,
            authUsage: turnUsage,
            conversationId: timeoutResumeConversationId,
            sessionId: timeoutResumeSessionId,
            sliceId: sessionRecord.sliceId,
          },
        );
      }
    }

    if (isRetryableTurnError(error)) {
      throw error;
    }
    if (isTurnInputCommitLostError(error)) {
      throw error;
    }
    if (error instanceof AuthorizationFlowDisabledError) {
      throw error;
    }
    if (context.onInputCommitted && !inputCommitted) {
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
        ...credentialActorLogContext,
        assistantUserName: botConfig.userName,
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
        ...(thinkingSelection
          ? {
              thinkingLevel: thinkingSelection.thinkingLevel,
            }
          : {}),
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
          "exception.message":
            closeError instanceof Error
              ? closeError.message
              : String(closeError),
        },
        "Failed to close MCP tool manager",
      );
    }
  }
}
