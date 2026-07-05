/**
 * Agent executor.
 *
 * Composition root and execution loop for one agent run slice after
 * runtime/ingress code has parsed and routed the request. Wires the phase
 * modules (session restore, skills, tools, prompt, resume), runs the Pi
 * agent with the inline provider retry loop, and translates expected run
 * endings into `AgentRunOutcome` values. Delivery and thread presentation
 * stay outside this module.
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
  setTags,
  summarizeMessageText,
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
import { isAssistantMessage } from "@/chat/pi/transcript";
import { createTracedStreamFn } from "@/chat/pi/traced-stream";
import { shouldEmitDevAgentTrace } from "@/chat/runtime/dev-agent-trace";
import { isTurnInputCommitLostError } from "@/chat/runtime/turn";
import type { AgentRunOutcome } from "@/chat/runtime/agent-run-outcome";
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
import { AuthorizationFlowDisabledError } from "@/chat/services/auth-pause";
import {
  resolveConversationPrivacy,
  runWithConversationPrivacy,
  toGenAiMessageMetadata,
  toGenAiMessagesTraceAttributes,
  type ConversationPrivacy,
} from "@/chat/conversation-privacy";
import {
  assertCorrelationDestinationMatch,
  assertRequesterDestinationMatch,
  getSessionIdentifiers,
  requesterFromRouting,
  surfaceFromRouting,
  type AgentRunRequest,
} from "@/chat/agent/request";
import { restoreSessionRecord } from "@/chat/agent/session";
import { discoverRunSkills, restoreSkillRuntime } from "@/chat/agent/skills";
import {
  assemblePrompt,
  buildPromptInput,
  buildSteeringPiMessage,
} from "@/chat/agent/prompt";
import { wireAgentTools } from "@/chat/agent/tools";
import { createResumeState, type ResumeState } from "@/chat/agent/resume";

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

/** Run a full agent turn: discover skills, execute tools, and return the assistant reply. */
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
    // it the turn fails closed to private telemetry capture.
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
  const { input, routing } = request;
  const policy = request.policy ?? {};
  const state = request.state ?? {};
  const observers = request.observers ?? {};
  const durability = request.durability ?? {};

  if (!routing.destination) {
    throw new TypeError("Assistant reply generation requires a destination");
  }
  assertRequesterDestinationMatch(routing);
  assertCorrelationDestinationMatch(routing);

  const replyStartedAtMs = Date.now();
  const configuredTurnDeadlineAtMs = replyStartedAtMs + botConfig.turnTimeoutMs;
  const policyTurnDeadlineAtMs =
    typeof policy.turnDeadlineAtMs === "number" &&
    Number.isFinite(policy.turnDeadlineAtMs)
      ? Math.floor(policy.turnDeadlineAtMs)
      : undefined;
  const turnDeadlineAtMs =
    policyTurnDeadlineAtMs === undefined
      ? configuredTurnDeadlineAtMs
      : Math.min(configuredTurnDeadlineAtMs, policyTurnDeadlineAtMs);
  const turnTimeoutBudgetMs = Math.max(0, turnDeadlineAtMs - replyStartedAtMs);

  let resume: ResumeState | undefined;
  let lastKnownSandboxId: string | undefined = state.sandbox?.sandboxId;
  let lastKnownSandboxDependencyProfileHash: string | undefined =
    state.sandbox?.sandboxDependencyProfileHash;
  let mcpToolManager: McpToolManager | undefined;
  let connectedMcpProviders = new Set<string>();
  let canRecordMcpProviders = false;
  let turnUsage: AgentTurnUsage | undefined;
  let thinkingSelection: TurnThinkingSelection | undefined;
  const requester = requesterFromRouting(routing);
  const surface = surfaceFromRouting(routing);
  const runSource = routing.source;
  const userInput = input.messageText;
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
  const { conversationId: sessionConversationId, sessionId } =
    getSessionIdentifiers(routing);
  const recordConnectedMcpProvider = async (provider: string) => {
    if (
      !canRecordMcpProviders ||
      !sessionConversationId ||
      connectedMcpProviders.has(provider)
    ) {
      return;
    }
    await recordMcpProviderConnected({
      conversationId: sessionConversationId,
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
  const getSandboxMetadata = () => ({
    sandboxId: lastKnownSandboxId,
    sandboxDependencyProfileHash: lastKnownSandboxDependencyProfileHash,
  });

  try {
    const shouldTrace = shouldEmitDevAgentTrace();
    const spanContext: LogContext = {
      conversationId: sessionConversationId,
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
    let loadedSkillNamesForResume: string[] = [];
    const syncLoadedSkillNamesForResume = () => {
      loadedSkillNamesForResume = activeSkills.map((skill) => skill.name);
    };
    const skillSandbox = new SkillSandbox(availableSkills, activeSkills);

    // ── Turn session record ──────────────────────────────────────────
    const {
      sessionRecordState,
      resumedFromSessionRecord,
      currentSliceId,
      existingSessionRecord,
    } = await restoreSessionRecord(routing);
    canRecordMcpProviders = Boolean(
      sessionRecordState.canUseTurnSession &&
      sessionConversationId &&
      sessionId,
    );
    resume = createResumeState({
      channelName: routing.correlation?.channelName,
      destination: routing.destination,
      durability,
      getLoadedSkillNames: () => loadedSkillNamesForResume,
      logContext: sessionRecordLogContext,
      recordActiveMcpProviders,
      requester,
      runSource,
      sessionConversationId,
      sessionId,
      sessionRecordState,
      startedAtMs: replyStartedAtMs,
      surface,
    });
    const runResume = resume;
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
        // failed append must not abort the in-flight model turn.
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
    const configurationValues: Record<string, unknown> = {
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

    // ── Prompt input ─────────────────────────────────────────────────
    const { routerBlocks, userContentParts } = buildPromptInput(input);
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

    // ── Mutable turn state ───────────────────────────────────────────
    const generatedFiles: FileUpload[] = [];
    const replyFiles: FileUpload[] = [];
    const artifactStatePatch: Partial<ThreadArtifactsState> = {};
    const toolCalls: string[] = [];
    let agent: Agent | undefined;
    const currentAgentMessages = (): PiMessage[] =>
      agent ? [...agent.state.messages] : [];

    setTags({
      conversationId: spanContext.conversationId,
      slackThreadId: routing.correlation?.threadId,
      slackUserId: routing.correlation?.requesterId,
      slackChannelId: routing.correlation?.channelId,
      runId: routing.correlation?.runId,
      ...credentialActorLogContext,
      assistantUserName: botConfig.userName,
      modelId: botConfig.modelId,
    });

    // ── Tool wiring ──────────────────────────────────────────────────
    const wiring = await wireAgentTools({
      abortAgent: () => agent?.abort(),
      activeSkills,
      actorRequester: requester,
      artifactStatePatch,
      availableSkills,
      configurationValues,
      connectedMcpProviders,
      conversationPrivacy,
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
      replyFiles,
      resume: runResume,
      routing,
      sessionConversationId,
      sessionId,
      skillSandbox,
      spanContext,
      state,
      surface,
      syncLoadedSkillNamesForResume,
      toolCalls,
      userInput,
    });
    mcpToolManager = wiring.mcpToolManager;
    const sandboxExecutor = wiring.sandboxExecutor;
    const getPendingAuthPause = wiring.getPendingAuthPause;

    // ── Prompt context ───────────────────────────────────────────────
    const {
      baseInstructions,
      inputMessages,
      inputMessagesAttribute,
      promptContentParts,
      promptHistoryMessages,
      shouldPromptAgent,
    } = await assemblePrompt({
      activeMcpCatalogs: wiring.activeMcpCatalogs,
      actorRequester: requester,
      artifactState: state.artifactState,
      availableSkills,
      configurationValues,
      conversationPrivacy,
      existingSessionPiMessages: existingSessionRecord?.piMessages,
      existingTurnStartMessageIndex:
        existingSessionRecord?.turnStartMessageIndex,
      invocation: skillInvocation,
      priorPiMessages,
      resumedFromSessionRecord,
      routing,
      spanContext,
      toolGuidance: wiring.toolGuidance,
      toolRuntimeContext: wiring.toolRuntimeContext,
      userContentParts,
    });

    // ── Agent execution ──────────────────────────────────────────────
    let hasEmittedText = false;
    let needsSeparator = false;
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
          await runResume.requireDurableInputCheckpoint([
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
        runResume.yieldAtSafeBoundaryIfDue(currentAgentMessages());
        return undefined;
      },
      initialState: {
        systemPrompt: baseInstructions,
        model: resolveGatewayModel(botConfig.modelId),
        thinkingLevel: toAgentThinkingLevel(thinkingSelection.thinkingLevel),
        tools: wiring.agentTools,
      },
    });

    const unsubscribe = agent.subscribe((event) => {
      if (event.type === "tool_execution_start") {
        return recordParentToolExecutionStart(event);
      }
      if (event.type === "turn_end" && event.toolResults.length > 0) {
        return runResume
          .persistSafeBoundary([...agent!.state.messages])
          .then(() => undefined);
      }
      if (event.type === "message_start") {
        Promise.resolve(observers.onAssistantMessageStart?.()).catch(
          (error) => {
            logWarn(
              "streaming_message_start_error",
              {},
              {
                "exception.message":
                  error instanceof Error ? error.message : String(error),
              },
              "Failed to deliver assistant message start to stream coordinator",
            );
          },
        );
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

      Promise.resolve(observers.onTextDelta?.(text)).catch((error) => {
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
    try {
      if (resumedFromSessionRecord) {
        agent.state.messages = shouldPromptAgent
          ? promptHistoryMessages
          : existingSessionRecord!.piMessages;
        runResume.setTurnStartMessageIndex(
          existingSessionRecord!.turnStartMessageIndex,
        );
      } else if (promptHistoryMessages.length > 0) {
        agent.state.messages = [...promptHistoryMessages];
      }
      runResume.setBeforeMessageCount(agent.state.messages.length);
      if (shouldPromptAgent) {
        runResume.setTurnStartMessageIndex(agent.state.messages.length);
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
              await runResume.requireDurableInputCheckpoint([
                ...agent!.state.messages,
                freshPromptMessage,
              ]);
            if (promptPersisted) {
              await runResume.commitInput();
            }
          }

          const runAgentStep = async (
            run: Promise<unknown>,
          ): Promise<unknown> => {
            let timeoutId: ReturnType<typeof setTimeout> | undefined;
            const timeoutPromise = new Promise<never>((_, reject) => {
              const rejectWithTimeout = () => {
                runResume.markTimedOut();
                agent!.abort();
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
              if (runResume.timedOut) {
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
                runResume.captureResumeSnapshot(
                  runResume.getResumeSnapshot(currentAgentMessages()),
                );
              }
              if (getPendingAuthPause()) {
                runResume.captureResumeSnapshot(
                  runResume.getResumeSnapshot(currentAgentMessages()),
                );
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
            ? agent!.prompt(freshPromptMessage)
            : agent!.continue();
          let retryUsage: AgentTurnUsage | undefined;
          for (let attempt = 0; ; attempt += 1) {
            promptResult = await runAgentStep(run);
            if (runResume.cooperativeYieldError) {
              throw runResume.cooperativeYieldError;
            }

            newMessages = agent!.state.messages.slice(
              runResume.beforeMessageCount,
            );
            const outputMessages = newMessages.filter(isAssistantMessage);
            const outputMessagesAttribute = serializeGenAiAttribute(
              conversationPrivacy !== "public"
                ? outputMessages.map(toGenAiMessageMetadata)
                : outputMessages,
            );
            const usageSummary = extractGenAiUsageSummary(
              promptResult,
              agent!.state,
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
              runResume.captureResumeSnapshot(
                runResume.getResumeSnapshot(currentAgentMessages()),
              );
              throw getPendingAuthPause()!;
            }

            const lastAssistant = outputMessages.at(-1);
            const providerRetry = nextProviderRetry({
              attempt,
              lastAssistant,
              messages: agent!.state.messages,
            });
            if (!providerRetry) {
              break;
            }

            retryUsage = turnUsage;
            agent!.state.messages = providerRetry.messages;
            await runResume.persistSafeBoundary(providerRetry.messages);
            logWarn(
              "agent_turn_provider_retry",
              spanContext,
              {},
              "Retrying transient provider failure",
            );
            await sleep(providerRetry.delayMs);
            run = agent!.continue();
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
    return {
      status: "completed",
      result: buildTurnResult({
        newMessages,
        userInput,
        replyFiles,
        artifactStatePatch,
        toolCalls,
        sandboxId: sandboxExecutor.getSandboxId(),
        sandboxDependencyProfileHash:
          sandboxExecutor.getDependencyProfileHash(),
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
    };
  } catch (error) {
    if (resume) {
      const { outcome } = await resume.translateExpectedEnding({
        currentUsage: turnUsage,
        error,
      });
      if (outcome) {
        return outcome;
      }
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
    if (durability.onInputCommitted && !resume?.inputCommitted) {
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
    return {
      status: "completed",
      result: {
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
