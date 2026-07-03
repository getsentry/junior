/**
 * Agent run orchestration.
 *
 * This module owns the Pi-facing execution boundary for one Junior run after
 * Slack/runtime code has parsed and routed the request. It assembles prompt context,
 * restores durable Pi/session state, wires tools/MCP/auth, executes the agent,
 * and persists resumable checkpoints. Slack delivery and thread presentation
 * should stay outside this file.
 */
import { Agent } from "@earendil-works/pi-agent-core";
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
  withSpan,
  type LogContext,
} from "@/chat/logging";
import { getConfigDefaults } from "@/chat/configuration/defaults";
import { SkillSandbox } from "@/chat/sandbox/skill-sandbox";
import {
  findSkillByName,
  parseSkillInvocation,
  type Skill,
} from "@/chat/skills";
import { McpToolManager } from "@/chat/mcp/tool-manager";
import type { ThreadArtifactsState } from "@/chat/state/artifacts";
import {
  loadConnectedMcpProviders,
  recordToolExecutionStarted,
  recordMcpProviderConnected,
} from "@/chat/state/session-log";
import {
  GEN_AI_PROVIDER_NAME,
  GEN_AI_SERVER_ADDRESS,
  GEN_AI_SERVER_PORT,
  completeObject,
  getPiGatewayApiKey,
  resolveGatewayModel,
} from "@/chat/pi/client";
import type { PiMessage } from "@/chat/pi/messages";
import { createTracedStreamFn } from "@/chat/pi/traced-stream";
import type { SandboxExecutor } from "@/chat/sandbox/sandbox";
import { shouldEmitDevAgentTrace } from "@/chat/runtime/dev-agent-trace";
import { isTurnInputCommitLostError } from "@/chat/runtime/turn";
import {
  completedAgentRun,
  failedAgentRun,
  type AgentRunOutcome,
} from "@/chat/runtime/agent-run-outcome";
import {
  isAssistantMessage,
  summarizeMessageText,
} from "@/chat/agent-run-helpers";
import { buildTurnResult } from "@/chat/services/turn-result";
import {
  isProviderRetryError,
  nextProviderRetry,
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
import type { AgentTurnSurface } from "@/chat/state/turn-session";
import { parseSlackThreadId } from "@/chat/slack/context";
import { createRequester, type Requester } from "@/chat/requester";
import { AuthorizationFlowDisabledError } from "@/chat/services/auth-pause";
import {
  resolveConversationPrivacy,
  runWithConversationPrivacy,
  toGenAiMessageMetadata,
  toGenAiMessagesTraceAttributes,
  type ConversationPrivacy,
} from "@/chat/conversation-privacy";
import {
  createSliceCheckpointer,
  type SliceCheckpointer,
} from "@/chat/agent-run/checkpointer";
import { restoreSessionRecord } from "@/chat/agent-run/session-restore";
import {
  discoverRunSkills,
  restoreSkillRuntime,
} from "@/chat/agent-run/skills";
import { subscribeToAgentEvents } from "@/chat/agent-run/events";
import {
  assemblePrompt,
  buildPromptInput,
  buildSteeringPiMessage,
} from "@/chat/agent-run/prompt";
import { wireAgentTools } from "@/chat/agent-run/tools";
import type {
  AgentRunRequest,
  AgentRunRouting,
} from "@/chat/agent-run/request";

export { buildSteeringPiMessage } from "@/chat/agent-run/prompt";
export type {
  AgentRunAttachment,
  AgentRunDurability,
  AgentRunInput,
  AgentRunObservers,
  AgentRunPolicy,
  AgentRunRequest,
  AgentRunRouting,
  AgentRunState,
  AgentRunSteeringMessage,
} from "@/chat/agent-run/request";

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

function requesterFromRouting(routing: AgentRunRouting): Requester | undefined {
  return actorRequesterFromRouting(routing);
}

/** Reject requester identities that do not belong to the active destination. */
function assertRequesterDestinationMatch(routing: AgentRunRouting): void {
  const { destination, requester } = routing;
  if (!requester) {
    return;
  }
  if (requester.platform !== destination.platform) {
    throw new TypeError(
      `Requester platform "${requester.platform}" does not match destination platform "${destination.platform}"`,
    );
  }
  if (
    requester.platform === "slack" &&
    destination.platform === "slack" &&
    requester.teamId !== destination.teamId
  ) {
    throw new TypeError("Slack requester team does not match destination team");
  }
}

/** Reject legacy Slack correlation fields that conflict with the destination. */
function assertCorrelationDestinationMatch(routing: AgentRunRouting): void {
  const { correlation, destination } = routing;
  if (destination.platform !== "slack") {
    return;
  }
  if (
    correlation?.channelId !== undefined &&
    correlation.channelId !== destination.channelId
  ) {
    throw new TypeError(
      "Slack correlation channel does not match destination channel",
    );
  }
  if (
    correlation?.teamId !== undefined &&
    correlation.teamId !== destination.teamId
  ) {
    throw new TypeError(
      "Slack correlation team does not match destination team",
    );
  }
}

function actorRequesterFromRouting(
  routing: AgentRunRouting,
): Requester | undefined {
  return createRequester(routing.requester, {
    platform:
      routing.requester?.platform ??
      (routing.destination.platform === "slack" ? "slack" : undefined),
    teamId:
      (routing.destination.platform === "slack"
        ? routing.destination.teamId
        : undefined) ??
      routing.correlation?.teamId ??
      (routing.requester?.platform === "slack"
        ? routing.requester.teamId
        : undefined),
    userId: routing.correlation?.requesterId,
  });
}

function surfaceFromRouting(
  routing: AgentRunRouting,
): AgentTurnSurface | undefined {
  if (routing.surface) {
    return routing.surface;
  }
  const conversationId =
    routing.correlation?.conversationId ??
    routing.correlation?.threadId ??
    routing.correlation?.runId;
  if (
    routing.slackConversation ||
    (conversationId ? parseSlackThreadId(conversationId) : undefined)
  ) {
    return "slack";
  }
  if (conversationId) {
    return "api";
  }
  return undefined;
}

/** Run one agent execution slice and return its lifecycle outcome. */
export async function executeAgentRun(
  request: AgentRunRequest,
): Promise<AgentRunOutcome> {
  const conversationPrivacy = resolveConversationPrivacy({
    channelId: request.routing.correlation?.channelId,
    conversationId:
      request.routing.correlation?.conversationId ??
      request.routing.correlation?.threadId ??
      request.routing.correlation?.runId,
    // Source-confirmed visibility from the live event's channel_type; without
    // it the run fails closed to private telemetry capture.
    visibility: request.routing.slackConversation?.visibility,
  });
  return runWithConversationPrivacy(conversationPrivacy ?? "private", () =>
    executeAgentRunInPrivacyContext(request, conversationPrivacy),
  );
}

async function executeAgentRunInPrivacyContext(
  request: AgentRunRequest,
  conversationPrivacy: ConversationPrivacy | undefined,
): Promise<AgentRunOutcome> {
  const {
    input,
    routing,
    policy = {},
    state = {},
    observers = {},
    durability = {},
  } = request;
  const { messageText } = input;

  if (!routing.destination) {
    throw new TypeError("Assistant reply generation requires a destination");
  }
  assertRequesterDestinationMatch(routing);
  assertCorrelationDestinationMatch(routing);

  const replyStartedAtMs = Date.now();
  const configuredTurnDeadlineAtMs = replyStartedAtMs + botConfig.turnTimeoutMs;
  const contextTurnDeadlineAtMs =
    typeof policy.turnDeadlineAtMs === "number" &&
    Number.isFinite(policy.turnDeadlineAtMs)
      ? Math.floor(policy.turnDeadlineAtMs)
      : undefined;
  const turnDeadlineAtMs =
    contextTurnDeadlineAtMs === undefined
      ? configuredTurnDeadlineAtMs
      : Math.min(configuredTurnDeadlineAtMs, contextTurnDeadlineAtMs);
  const turnTimeoutBudgetMs = Math.max(0, turnDeadlineAtMs - replyStartedAtMs);
  let lastKnownSandboxId: string | undefined = policy.sandbox?.sandboxId;
  let lastKnownSandboxDependencyProfileHash: string | undefined =
    policy.sandbox?.sandboxDependencyProfileHash;
  let loadedSkillNamesForResume: string[] = [];
  let mcpToolManager: McpToolManager | undefined;
  let connectedMcpProviders = new Set<string>();
  let canRecordMcpProviders = false;
  let mcpProviderConversationId: string | undefined;
  let sandboxExecutor: SandboxExecutor | undefined;
  let sliceCheckpointer: SliceCheckpointer | undefined;
  let turnUsage: AgentTurnUsage | undefined;
  let thinkingSelection: TurnThinkingSelection | undefined;
  const requester = requesterFromRouting(routing);
  const actorRequester = actorRequesterFromRouting(routing);
  const surface = surfaceFromRouting(routing);
  const runSource = routing.source;
  const credentialActor = routing.credentialContext?.actor;
  const credentialActorLogContext = credentialActor
    ? {
        actorType: credentialActor.type,
        actorId:
          credentialActor.type === "user"
            ? credentialActor.userId
            : credentialActor.id,
      }
    : {};
  const sessionRecordLogContext = {
    threadId: routing.correlation?.threadId,
    requesterId: routing.correlation?.requesterId,
    channelId: routing.correlation?.channelId,
    runId: routing.correlation?.runId,
    ...credentialActorLogContext,
    assistantUserName: botConfig.userName,
    modelId: botConfig.modelId,
  };
  const recordConnectedMcpProvider = async (provider: string) => {
    if (
      !canRecordMcpProviders ||
      !mcpProviderConversationId ||
      connectedMcpProviders.has(provider)
    ) {
      return;
    }
    await recordMcpProviderConnected({
      conversationId: mcpProviderConversationId,
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
        routing.correlation?.conversationId ??
        routing.correlation?.threadId ??
        routing.correlation?.runId,
      slackThreadId: routing.correlation?.threadId,
      slackUserId: routing.correlation?.requesterId,
      slackChannelId: routing.correlation?.channelId,
      runId: routing.correlation?.runId,
      ...credentialActorLogContext,
      assistantUserName: botConfig.userName,
      modelId: botConfig.modelId,
    };

    // ── Skill discovery ──────────────────────────────────────────────
    const availableSkills = await discoverRunSkills({
      skillDirs: policy.skillDirs,
      spanContext,
    });
    let configurationValues: Record<string, unknown>;
    const userInput = messageText;
    if (shouldTrace) {
      const inboundAttachmentCount = input.inboundAttachmentCount ?? 0;
      const promptAttachmentCount = input.userAttachments?.length ?? 0;
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
          "messaging.message.id": routing.correlation?.messageTs ?? "",
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

    // ── Session Record ────────────────────────────────────────
    const {
      currentSliceId,
      existingSessionRecord,
      resumedFromSessionRecord,
      sessionConversationId,
      sessionId,
      sessionRecordState,
    } = await restoreSessionRecord(routing);
    mcpProviderConversationId = sessionConversationId;
    canRecordMcpProviders = Boolean(
      sessionRecordState.canUseTurnSession &&
      sessionConversationId &&
      sessionId,
    );
    const checkpointer = createSliceCheckpointer({
      channelName: routing.correlation?.channelName,
      destination: routing.destination,
      durability,
      logContext: sessionRecordLogContext,
      recordActiveMcpProviders,
      requester,
      runSource,
      sessionConversationId,
      sessionId,
      startedAtMs: replyStartedAtMs,
      surface,
      sessionRecordState,
      getLoadedSkillNames: () => loadedSkillNamesForResume,
    });
    sliceCheckpointer = checkpointer;
    const recordParentToolExecutionStart = async (event: {
      args: unknown;
      toolCallId: string;
      toolName: string;
    }) => {
      if (
        !sessionRecordState.canUseTurnSession ||
        !sessionConversationId ||
        !sessionId
      ) {
        return;
      }
      try {
        await recordToolExecutionStarted({
          conversationId: sessionConversationId,
          sessionId,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: event.args,
          ttlMs: THREAD_STATE_TTL_MS,
        });
      } catch (error) {
        // Host-only activity events are best-effort reporting writes; a
        // failed append must not abort the in-flight model run.
        logException(
          error,
          "agent_turn_session_log_append_failed",
          spanContext,
          {
            "gen_ai.tool.name": event.toolName,
          },
          "Failed to record host-only tool execution start",
        );
      }
    };
    const persistedConfigurationValues = policy.channelConfiguration
      ? await policy.channelConfiguration.resolveValues()
      : {};
    configurationValues = {
      ...getConfigDefaults(),
      ...(policy.configuration ?? {}),
      ...persistedConfigurationValues,
    };
    // Match the history source the agent will actually receive so crash retries
    // do not let an unstripped running record suppress fresh turn context.
    const priorPiMessages = resumedFromSessionRecord
      ? existingSessionRecord?.piMessages
      : input.piMessages;
    connectedMcpProviders = new Set(
      sessionRecordState.canUseTurnSession && sessionConversationId
        ? await loadConnectedMcpProviders({
            conversationId: sessionConversationId,
          })
        : [],
    );
    // ── Restore skill runtime handles from durable Pi history ────────
    await restoreSkillRuntime({
      activeSkills,
      invokedSkill,
      priorPiMessages,
      skillSandbox,
      syncLoadedSkillNamesForResume,
    });

    const { routerBlocks, userContentParts } = buildPromptInput({
      input,
      userInput,
    });
    const preAgentPromptMessages = (): PiMessage[] =>
      existingSessionRecord?.piMessages ?? [...(input.piMessages ?? [])];

    thinkingSelection = await selectTurnThinkingLevel({
      completeObject,
      conversationContext: input.conversationContext,
      context: {
        threadId: routing.correlation?.threadId,
        channelId: routing.correlation?.channelId,
        requesterId: routing.correlation?.requesterId,
        runId: routing.correlation?.runId,
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

    // ── Mutable run state ────────────────────────────────────────────
    checkpointer.resetResumeSnapshot();
    const generatedFiles: FileUpload[] = [];
    const deliveryFiles: FileUpload[] = [];
    const artifactStatePatch: Partial<ThreadArtifactsState> = {};
    const toolCalls: string[] = [];
    let agent: Agent | undefined;
    const captureCurrentResumeSnapshot = (): void => {
      checkpointer.captureResumeSnapshot(
        checkpointer.getResumeSnapshot(agent ? [...agent.state.messages] : []),
      );
    };

    const toolWiring = await wireAgentTools({
      abortAgent: () => agent?.abort(),
      activeSkills,
      actorRequester,
      artifactStatePatch,
      availableSkills,
      checkpointer,
      configurationValues,
      connectedMcpProviders,
      conversationPrivacy,
      deliveryFiles,
      durability,
      generatedFiles,
      invokedSkill,
      observers,
      onSandboxMetadataChanged: (sandbox) => {
        lastKnownSandboxId = sandbox.sandboxId;
        lastKnownSandboxDependencyProfileHash =
          sandbox.sandboxDependencyProfileHash;
      },
      policy,
      preAgentPromptMessages,
      priorPiMessages,
      recordConnectedMcpProvider,
      routing,
      runSource,
      sessionConversationId,
      sessionId,
      skillInvocation,
      skillSandbox,
      spanContext,
      state,
      surface,
      syncLoadedSkillNamesForResume,
      toolCalls,
      userInput,
    });
    mcpToolManager = toolWiring.mcpToolManager;
    sandboxExecutor = toolWiring.currentSandboxExecutor;
    const currentSandboxExecutor = toolWiring.currentSandboxExecutor;
    const { agentTools, getPendingAuthPause, toolRuntimeContext } = toolWiring;

    const {
      baseInstructions,
      inputMessages,
      inputMessagesAttribute,
      promptContentParts,
      promptHistoryMessages,
      shouldPromptAgent,
    } = await assemblePrompt({
      activeMcpCatalogs: toolWiring.activeMcpCatalogs,
      actorRequester,
      artifactState: state.artifactState,
      availableSkills,
      configurationValues,
      conversationPrivacy,
      dispatch: routing.dispatch,
      existingRunStartMessageIndex:
        existingSessionRecord?.turnStartMessageIndex,
      existingSessionPiMessages: existingSessionRecord?.piMessages,
      invocation: skillInvocation,
      priorPiMessages,
      resumedFromSessionRecord,
      routing,
      source: runSource,
      spanContext,
      toolGuidance: toolWiring.toolGuidance,
      toolRuntimeContext,
      userContentParts,
    });

    // ── Agent execution ──────────────────────────────────────────────
    const drainSteeringMessages = async (): Promise<void> => {
      if (
        !durability.drainSteeringMessages ||
        !sessionRecordState.canUseTurnSession ||
        !sessionConversationId ||
        !sessionId
      ) {
        return;
      }

      try {
        let steeredMessageCount = 0;
        await durability.drainSteeringMessages(async (messages) => {
          const piMessages = messages.map(buildSteeringPiMessage);
          if (piMessages.length === 0) {
            return;
          }
          await checkpointer.requireDurableInputCheckpoint([
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
            "agent_turn_steering_messages_accepted",
            spanContext,
            {
              "app.ai.steering_message_count": steeredMessageCount,
            },
            "Agent turn steering messages accepted",
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
    const apiKeyOverride = getPiGatewayApiKey();
    agent = new Agent({
      ...(apiKeyOverride ? { getApiKey: () => apiKeyOverride } : {}),
      streamFn: createTracedStreamFn({ conversationPrivacy }),
      steeringMode: "all",
      prepareNextTurn: async () => {
        await drainSteeringMessages();
        checkpointer.yieldAtSafeBoundaryIfDue(
          agent ? [...agent.state.messages] : [],
        );
        return undefined;
      },
      initialState: {
        systemPrompt: baseInstructions,
        model: resolveGatewayModel(botConfig.modelId),
        thinkingLevel: toAgentThinkingLevel(thinkingSelection.thinkingLevel),
        tools: agentTools,
      },
    });

    const unsubscribe = subscribeToAgentEvents({
      agent,
      checkpointer,
      observers,
      recordParentToolExecutionStart,
      spanContext,
    });

    let newMessages: PiMessage[] = [];
    checkpointer.setBeforeMessageCount(agent.state.messages.length);
    try {
      if (resumedFromSessionRecord) {
        agent.state.messages = shouldPromptAgent
          ? promptHistoryMessages
          : existingSessionRecord!.piMessages;
        checkpointer.setRunStartMessageIndex(
          existingSessionRecord!.turnStartMessageIndex,
        );
      } else if (promptHistoryMessages.length > 0) {
        agent.state.messages = [...promptHistoryMessages];
      }
      checkpointer.setBeforeMessageCount(agent.state.messages.length);
      if (shouldPromptAgent) {
        checkpointer.setRunStartMessageIndex(checkpointer.beforeMessageCount);
      }

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
          if (shouldPromptAgent) {
            const promptPersisted =
              await checkpointer.requireDurableInputCheckpoint([
                ...agent.state.messages,
                freshPromptMessage,
              ]);
            if (promptPersisted) {
              await checkpointer.commitInput();
            }
          }

          const runAgentStep = async (
            run: Promise<unknown>,
          ): Promise<unknown> => {
            let timeoutId: ReturnType<typeof setTimeout> | undefined;
            const timeoutPromise = new Promise<never>((_, reject) => {
              const rejectWithTimeout = () => {
                checkpointer.markTimedOut();
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
              if (checkpointer.timedOut) {
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
                captureCurrentResumeSnapshot();
              }
              if (getPendingAuthPause()) {
                captureCurrentResumeSnapshot();
                throw getPendingAuthPause()!;
              }
              throw error;
            } finally {
              if (timeoutId) {
                clearTimeout(timeoutId);
              }
            }
          };

          let run = shouldPromptAgent
            ? agent.prompt(freshPromptMessage)
            : agent.continue();
          let retryUsage: AgentTurnUsage | undefined;
          for (let attempt = 0; ; attempt += 1) {
            promptResult = await runAgentStep(run);
            if (checkpointer.cooperativeYieldError) {
              const cooperativeYieldError = checkpointer.cooperativeYieldError;
              throw cooperativeYieldError;
            }

            newMessages = agent.state.messages.slice(
              checkpointer.beforeMessageCount,
            );
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
              captureCurrentResumeSnapshot();
              throw getPendingAuthPause()!;
            }

            const lastAssistant = outputMessages.at(-1);
            const providerRetry = nextProviderRetry({
              attempt,
              lastAssistant,
              messages: agent.state.messages,
            });
            if (!providerRetry) {
              break;
            }

            retryUsage = turnUsage;
            agent.state.messages = providerRetry.messages;
            await checkpointer.persistSafeBoundary(providerRetry.messages);
            logWarn(
              "agent_turn_provider_retry",
              spanContext,
              {},
              "Retrying transient provider failure",
            );
            await sleep(providerRetry.delayMs);
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
          ...(currentSliceId ? { "app.ai.turn.slice_id": currentSliceId } : {}),
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
      sessionRecordState.canUseTurnSession &&
      sessionConversationId &&
      sessionId
    ) {
      await recordActiveMcpProviders();
      // Generation completing is not delivery: the session record stays at its
      // latest running safe boundary here. The destination boundary commits
      // the final messages and terminal completed state only after the visible
      // reply is accepted, so an undelivered assistant reply never surfaces as
      // delivered conversation history and a crash before delivery stays
      // recoverable through stranded-running continuation.
    }

    // ── Build turn result ────────────────────────────────────────────
    return completedAgentRun(
      buildTurnResult({
        newMessages,
        userInput,
        replyFiles: deliveryFiles,
        artifactStatePatch,
        toolCalls,
        sandboxId: currentSandboxExecutor.getSandboxId(),
        sandboxDependencyProfileHash:
          currentSandboxExecutor.getDependencyProfileHash(),
        piMessages: [...agent.state.messages],
        durationMs: Date.now() - replyStartedAtMs,
        generatedFileCount: generatedFiles.length,
        shouldTrace,
        spanContext,
        usage: turnUsage,
        thinkingSelection,
        correlation: routing.correlation,
        assistantUserName: botConfig.userName,
      }),
    );
  } catch (error) {
    const expectedEnding = await sliceCheckpointer?.translateExpectedEnding({
      currentUsage: turnUsage,
      error,
      thinkingSelection,
    });
    if (expectedEnding?.usage) {
      turnUsage = expectedEnding.usage;
    }
    if (expectedEnding?.outcome) {
      return expectedEnding.outcome;
    }

    if (isProviderRetryError(error)) {
      throw error;
    }
    if (isTurnInputCommitLostError(error)) {
      throw error;
    }
    if (error instanceof AuthorizationFlowDisabledError) {
      throw error;
    }
    if (durability.onInputCommitted && !sliceCheckpointer?.inputCommitted) {
      throw error;
    }

    logException(
      error,
      "assistant_reply_generation_failed",
      {
        slackThreadId: routing.correlation?.threadId,
        slackUserId: routing.correlation?.requesterId,
        slackChannelId: routing.correlation?.channelId,
        runId: routing.correlation?.runId,
        ...credentialActorLogContext,
        assistantUserName: botConfig.userName,
        modelId: botConfig.modelId,
      },
      {},
      "executeAgentRun failed",
    );

    // Raw exception text is diagnostics-only; the failure-response service
    // owns the sanitized user-visible fallback for empty provider errors.
    const message = error instanceof Error ? error.message : String(error);
    return failedAgentRun({
      text: "",
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
    });
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
