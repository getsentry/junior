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
import { Agent, type AgentLoopTurnUpdate } from "@earendil-works/pi-agent-core";
import { isRetryableAssistantError } from "@earendil-works/pi-ai";
import type { FileUpload } from "chat";
import { botConfig } from "@/chat/config";
import {
  extractGenAiUsageAttributes,
  extractGenAiUsageSummary,
  logException,
  logInfo,
  logWarn,
  normalizeGenAiFinishReason,
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
  openConversationProjection,
  recordToolExecutionStarted,
  recordMcpProviderConnected,
} from "@/chat/conversations/projection";
import {
  instructionActors,
  instructionProvenanceFor,
  type PiMessageProvenance,
} from "@/chat/state/session-log";
import type { Actor } from "@/chat/actor";
import {
  GEN_AI_PROVIDER_NAME,
  completeObject,
  completeText,
  getPiGatewayApiKey,
  resolveGatewayModel,
} from "@/chat/pi/client";
import type { PiMessage } from "@/chat/pi/messages";
import {
  isAssistantMessage,
  retainRuntimeTurnContext,
} from "@/chat/pi/transcript";
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
  configuredTurnReasoningLevel,
  selectTurnReasoningLevel,
  toPiReasoningLevel,
} from "@/chat/services/turn-reasoning-level";
import {
  addAgentTurnUsage,
  hasAgentTurnUsage,
  type AgentTurnUsage,
} from "@/chat/usage";
import { AuthorizationFlowDisabledError } from "@/chat/services/auth-pause";
import {
  resolveConversationPrivacy,
  runWithConversationPrivacy,
  toCanonicalOutputMessage,
  toGenAiMessagesTraceAttributes,
  type ConversationPrivacy,
} from "@/chat/conversation-privacy";
import {
  assertCorrelationDestinationMatch,
  assertActorDestinationMatch,
  getSessionIdentifiers,
  actorFromRouting,
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
import { sleep } from "@/chat/sleep";
import {
  DEFAULT_HANDOFF_MODEL_PROFILE,
  modelIdForProfile,
  ModelProfileNotConfiguredError,
  STANDARD_MODEL_PROFILE,
  type ModelProfile,
} from "@/chat/model-profile";
import { compactContextForHandoff } from "@/chat/services/context-compaction";
import { HANDOFF_TOOL_NAME } from "@/chat/tools/handoff/tool";

const AGENT_ABORT_SETTLE_GRACE_MS = 5_000;

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
  const signal = policy.signal;
  const state = request.state ?? {};
  const observers = request.observers ?? {};
  const durability = request.durability ?? {};

  signal?.throwIfAborted();

  if (!routing.destination) {
    throw new TypeError("Assistant reply generation requires a destination");
  }
  assertActorDestinationMatch(routing);
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
  let handoffPhaseUsage: AgentTurnUsage | undefined;
  const configuredReasoningLevel =
    policy.reasoningLevel ?? botConfig.reasoningLevel;
  let reasoningSelection = configuredReasoningLevel
    ? configuredTurnReasoningLevel(
        configuredReasoningLevel,
        policy.reasoningLevel ? "agent_config" : "default",
      )
    : undefined;
  let activeModelProfile: ModelProfile = STANDARD_MODEL_PROFILE;
  let activeModelId = modelIdForProfile(botConfig, activeModelProfile);
  const actor = actorFromRouting(routing);
  const surface = surfaceFromRouting(routing);
  const runSource = routing.source;
  const userInput = input.messageText;
  const credentialActor = routing.credentialContext?.actor;
  const credentialActorLogContext = credentialActor
    ? {
        actorType: "type" in credentialActor ? credentialActor.type : "system",
        actorId:
          "type" in credentialActor
            ? credentialActor.userId
            : credentialActor.name,
      }
    : {};
  const sessionRecordLogContext = {
    threadId: routing.correlation?.threadId,
    actorId: routing.correlation?.actorId,
    channelId: routing.correlation?.channelId,
    runId: routing.correlation?.runId,
    ...credentialActorLogContext,
    assistantUserName: botConfig.userName,
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
    if (sessionConversationId) {
      const projection = await openConversationProjection({
        conversationId: sessionConversationId,
        modelId: activeModelId,
      });
      activeModelProfile = projection.modelProfile;
      activeModelId = modelIdForProfile(botConfig, activeModelProfile);
    }
    const shouldTrace = shouldEmitDevAgentTrace();
    const spanContext: LogContext = {
      conversationId: sessionConversationId,
      slackThreadId: routing.correlation?.threadId,
      slackUserId: routing.correlation?.actorId,
      slackChannelId: routing.correlation?.channelId,
      runId: routing.correlation?.runId,
      ...credentialActorLogContext,
      assistantUserName: botConfig.userName,
      modelId: activeModelId,
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
    // Mirror the committed provenance prefix the turn session record owns. A
    // fresh run may already include batched parked input committed before the
    // agent starts, then adds the current actor's turn-start instruction.
    // Steering appends to this array as it drains, so `run.actors` stays a
    // pure, live projection of committed instruction provenance.
    const committedInstructionProvenance: PiMessageProvenance[] = [
      ...(existingSessionRecord?.piMessageProvenance ?? []),
      ...(existingSessionRecord?.actors ?? []).map(instructionProvenanceFor),
      ...(resumedFromSessionRecord ? [] : [instructionProvenanceFor(actor)]),
    ];
    const runActors = (): Actor[] =>
      instructionActors(committedInstructionProvenance);
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
      getReasoningLevel: () => reasoningSelection?.reasoningLevel,
      logContext: sessionRecordLogContext,
      getModelId: () => activeModelId,
      recordActiveMcpProviders,
      actor,
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
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: event.args,
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

    reasoningSelection ??= await selectTurnReasoningLevel({
      completeObject,
      conversationContext: input.conversationContext,
      context: {
        threadId: routing.correlation?.threadId,
        channelId: routing.correlation?.channelId,
        actorId: routing.correlation?.actorId,
        runId: routing.correlation?.runId,
      },
      currentTurnBlocks: routerBlocks,
      fastModelId: botConfig.fastModelId,
      messageText: userInput,
    });

    // ── Mutable turn state ───────────────────────────────────────────
    const generatedFiles: FileUpload[] = [];
    const artifactStatePatch: Partial<ThreadArtifactsState> = {};
    const toolCalls: string[] = [];
    let agent: Agent | undefined;
    // Handoff becomes live only after its replacement epoch commits. This
    // pending value then drives the one-way model/context swap at Pi's boundary.
    let pendingHandoff:
      | {
          messages: PiMessage[];
          model: ReturnType<typeof resolveGatewayModel>;
          thinkingLevel: NonNullable<AgentLoopTurnUpdate["thinkingLevel"]>;
        }
      | undefined;
    const currentAgentMessages = (): PiMessage[] =>
      agent ? [...agent.state.messages] : [];
    const handoffProfiles: [ModelProfile, ...ModelProfile[]] = [
      DEFAULT_HANDOFF_MODEL_PROFILE,
      ...Object.keys(botConfig.modelProfiles)
        .filter((profile) => profile !== DEFAULT_HANDOFF_MODEL_PROFILE)
        .sort(),
    ];
    const requestHandoff =
      activeModelProfile === STANDARD_MODEL_PROFILE && sessionConversationId
        ? {
            profiles: handoffProfiles,
            execute: async (profile: ModelProfile, signal?: AbortSignal) => {
              const sourceMessages = [...agent!.state.messages];
              const runtimeContext = retainRuntimeTurnContext(sourceMessages);
              const standardPhaseUsage = extractGenAiUsageSummary(
                ...sourceMessages
                  .slice(runResume.beforeMessageCount)
                  .filter(isAssistantMessage),
              );
              const phaseUsage = hasAgentTurnUsage(standardPhaseUsage)
                ? standardPhaseUsage
                : undefined;
              const target = {
                modelId: modelIdForProfile(botConfig, profile),
                modelProfile: profile,
              };
              const handoffModel = resolveGatewayModel(target.modelId);
              const handoffThinkingLevel = toPiReasoningLevel(
                reasoningSelection!.reasoningLevel,
              );
              void (async () => {
                await observers.onStatus?.({ text: "Switching models" });
              })().catch((error) => {
                logWarn(
                  "assistant_status_observer_failed",
                  {},
                  {
                    "exception.message":
                      error instanceof Error ? error.message : String(error),
                  },
                  "Failed to report assistant status",
                );
              });
              const handoffMessages = await compactContextForHandoff(
                {
                  conversationContext: input.conversationContext,
                  conversationId: sessionConversationId,
                  piMessages: sourceMessages,
                  runtimeContext,
                  signal,
                  target,
                  metadata: {
                    threadId: routing.correlation?.threadId,
                    channelId: routing.correlation?.channelId,
                    actorId: routing.correlation?.actorId,
                    runId: routing.correlation?.runId,
                  },
                },
                { completeText },
              );
              handoffPhaseUsage = phaseUsage;
              pendingHandoff = {
                messages: handoffMessages,
                model: handoffModel,
                thinkingLevel: handoffThinkingLevel,
              };
              activeModelProfile = profile;
              activeModelId = target.modelId;
            },
          }
        : undefined;

    setTags({
      conversationId: spanContext.conversationId,
      slackThreadId: routing.correlation?.threadId,
      slackUserId: routing.correlation?.actorId,
      slackChannelId: routing.correlation?.channelId,
      runId: routing.correlation?.runId,
      ...credentialActorLogContext,
      assistantUserName: botConfig.userName,
      modelId: activeModelId,
    });

    // ── Tool wiring ──────────────────────────────────────────────────
    const wiring = await wireAgentTools({
      abortAgent: () => agent?.abort(),
      activeSkills,
      currentActor: actor,
      currentActors: runActors,
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
      requestHandoff,
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
    const toolsAfterHandoff = wiring.agentTools.filter(
      (tool) => tool.name !== HANDOFF_TOOL_NAME,
    );

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
      currentActor: actor,
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
    // Standard text is provisional until message_end proves the assistant did
    // not request handoff; post-handoff output can stream immediately.
    let bufferedStandardText = "";
    let bufferedStandardMessageStart = false;
    const startAssistantMessage = () => {
      Promise.resolve(observers.onAssistantMessageStart?.()).catch((error) => {
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
    };
    const deliverText = (deltaText: string) => {
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
    };
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
          await runResume.requireDurableInputCheckpoint(
            [...agent!.state.messages, ...piMessages],
            messages.map((message) => message.provenance),
          );
          committedInstructionProvenance.push(
            ...messages.map((message) => message.provenance),
          );
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
      beforeToolCall: async ({ assistantMessage }) => {
        const toolCalls = assistantMessage.content.filter(
          (part) => part.type === "toolCall",
        );
        const containsHandoff = toolCalls.some(
          (call) => call.name === HANDOFF_TOOL_NAME,
        );
        if (containsHandoff && toolCalls.length !== 1) {
          return {
            block: true,
            reason:
              "handoff must be the only tool call in its assistant message; reissue it alone",
          };
        }
        return undefined;
      },
      prepareNextTurn: async () => {
        let update: AgentLoopTurnUpdate | undefined;
        if (pendingHandoff) {
          const { messages, model, thinkingLevel } = pendingHandoff;
          const replacement = [...messages];
          pendingHandoff = undefined;
          agent!.state.messages = replacement;
          agent!.state.model = model;
          agent!.state.thinkingLevel = thinkingLevel;
          agent!.state.tools = toolsAfterHandoff;
          runResume.setBeforeMessageCount(replacement.length);
          runResume.setTurnStartMessageIndex(0);
          runResume.adoptCommittedBoundary(replacement);
          setSpanAttributes({
            "gen_ai.agent.model": activeModelId,
            "gen_ai.agent.model_profile": activeModelProfile,
            "gen_ai.agent.reasoning.level": reasoningSelection!.reasoningLevel,
          });
          update = {
            context: {
              systemPrompt: baseInstructions,
              messages: replacement,
              tools: toolsAfterHandoff,
            },
            model,
            thinkingLevel,
          };
        }
        await drainSteeringMessages();
        runResume.yieldAtSafeBoundaryIfDue(currentAgentMessages());
        return update;
      },
      initialState: {
        systemPrompt: baseInstructions,
        model: resolveGatewayModel(activeModelId),
        thinkingLevel: toPiReasoningLevel(reasoningSelection.reasoningLevel),
        tools: wiring.agentTools,
      },
    });

    const unsubscribe = agent.subscribe((event) => {
      if (event.type === "tool_execution_start") {
        return recordParentToolExecutionStart(event);
      }
      if (event.type === "turn_end" && event.toolResults.length > 0) {
        if (pendingHandoff) {
          return;
        }
        return runResume
          .persistSafeBoundary([...agent!.state.messages])
          .then(() => undefined);
      }
      if (event.type === "message_start") {
        if (activeModelProfile === STANDARD_MODEL_PROFILE && requestHandoff) {
          bufferedStandardMessageStart = true;
          bufferedStandardText = "";
        } else {
          startAssistantMessage();
        }
        return;
      }
      if (event.type === "message_end" && isAssistantMessage(event.message)) {
        if (!bufferedStandardMessageStart) {
          return;
        }
        const containsHandoff = event.message.content.some(
          (part) => part.type === "toolCall" && part.name === HANDOFF_TOOL_NAME,
        );
        if (!containsHandoff) {
          startAssistantMessage();
          if (bufferedStandardText) {
            deliverText(bufferedStandardText);
          }
        }
        bufferedStandardMessageStart = false;
        bufferedStandardText = "";
        return;
      }
      if (event.type !== "message_update") return;
      if (event.assistantMessageEvent.type !== "text_delta") return;
      const deltaText = event.assistantMessageEvent.delta;
      if (!deltaText) return;
      if (bufferedStandardMessageStart) {
        bufferedStandardText += deltaText;
      } else {
        deliverText(deltaText);
      }
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
        `invoke_agent ${botConfig.userName}`,
        "gen_ai.invoke_agent",
        spanContext,
        async () => {
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
            let removeAbortListener: (() => void) | undefined;
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
            const abortPromise = signal
              ? new Promise<never>((_, reject) => {
                  const rejectWithAbort = () => {
                    agent!.abort();
                    reject(signal.reason);
                  };
                  if (signal.aborted) {
                    rejectWithAbort();
                    return;
                  }
                  signal.addEventListener("abort", rejectWithAbort, {
                    once: true,
                  });
                  removeAbortListener = () =>
                    signal.removeEventListener("abort", rejectWithAbort);
                })
              : undefined;

            try {
              return await Promise.race(
                abortPromise
                  ? [run, timeoutPromise, abortPromise]
                  : [run, timeoutPromise],
              );
            } catch (error) {
              if (runResume.timedOut) {
                logWarn(
                  "agent_turn_timeout",
                  {},
                  {
                    "gen_ai.provider.name": GEN_AI_PROVIDER_NAME,
                    "gen_ai.operation.name": "invoke_agent",
                    "gen_ai.request.model": activeModelId,
                    ...(reasoningSelection
                      ? {
                          "gen_ai.request.reasoning.level":
                            reasoningSelection.reasoningLevel,
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
              removeAbortListener?.();
            }
          };

          let run = shouldPromptAgent
            ? agent!.prompt(freshPromptMessage)
            : agent!.continue();
          let retryUsage: AgentTurnUsage | undefined;
          for (let attempt = 0; ; attempt += 1) {
            await runAgentStep(run);
            signal?.throwIfAborted();
            if (runResume.cooperativeYieldError) {
              throw runResume.cooperativeYieldError;
            }

            newMessages = agent!.state.messages.slice(
              runResume.beforeMessageCount,
            );
            const outputMessages = newMessages.filter(isAssistantMessage);
            const outputMessagesAttribute = serializeGenAiAttribute(
              conversationPrivacy === "public"
                ? outputMessages.map(toCanonicalOutputMessage)
                : undefined,
            );
            const lastAssistant = outputMessages.at(-1);
            const usageSummary = extractGenAiUsageSummary(...outputMessages);
            const currentUsage = hasAgentTurnUsage(usageSummary)
              ? usageSummary
              : undefined;
            const currentPhaseUsage = addAgentTurnUsage(
              retryUsage,
              currentUsage,
            );
            turnUsage = addAgentTurnUsage(handoffPhaseUsage, currentPhaseUsage);
            setSpanAttributes({
              ...(outputMessagesAttribute
                ? { "gen_ai.output.messages": outputMessagesAttribute }
                : {}),
              ...toGenAiMessagesTraceAttributes(
                "gen_ai.output",
                outputMessages,
              ),
              ...(lastAssistant
                ? {
                    "gen_ai.response.finish_reasons": [
                      normalizeGenAiFinishReason(lastAssistant.stopReason),
                    ],
                  }
                : {}),
              ...extractGenAiUsageAttributes(usageSummary),
            });
            if (getPendingAuthPause()) {
              runResume.captureResumeSnapshot(
                runResume.getResumeSnapshot(currentAgentMessages()),
              );
              throw getPendingAuthPause()!;
            }

            const providerRetry = nextProviderRetry({
              attempt,
              messages: agent!.state.messages,
              retryableFailure:
                lastAssistant !== undefined &&
                isRetryableAssistantError(lastAssistant),
            });
            if (!providerRetry) {
              break;
            }

            retryUsage = currentPhaseUsage;
            agent!.state.messages = providerRetry.messages;
            await runResume.persistSafeBoundary(providerRetry.messages);
            logWarn(
              "agent_turn_provider_retry",
              spanContext,
              {},
              "Retrying transient provider failure",
            );
            await sleep(providerRetry.delayMs, signal);
            signal?.throwIfAborted();
            run = agent!.continue();
          }
        },
        {
          "gen_ai.operation.name": "invoke_agent",
          "gen_ai.agent.model": activeModelId,
          "gen_ai.agent.model_profile": activeModelProfile,
          "gen_ai.agent.reasoning.level": reasoningSelection.reasoningLevel,
          "gen_ai.agent.reasoning.level_reason": reasoningSelection.reason,
          ...(reasoningSelection.confidence !== undefined
            ? {
                "gen_ai.agent.reasoning.level_confidence":
                  reasoningSelection.confidence,
              }
            : {}),
          "gen_ai.output.type": "text",
          ...(conversationPrivacy
            ? { "app.conversation.privacy": conversationPrivacy }
            : {}),
          ...(sessionConversationId
            ? { "app.ai.session.conversation_id": sessionConversationId }
            : {}),
          ...(sessionId ? { "app.ai.turn.session_id": sessionId } : {}),
          ...(currentSliceId ? { "app.ai.turn.slice_id": currentSliceId } : {}),
          ...toGenAiMessagesTraceAttributes("gen_ai.input", inputMessages),
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
        reasoningSelection,
        correlation: routing.correlation,
        assistantUserName: botConfig.userName,
        modelId: activeModelId,
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

    if (error instanceof ModelProfileNotConfiguredError) {
      throw error;
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
        slackUserId: routing.correlation?.actorId,
        slackChannelId: routing.correlation?.channelId,
        runId: routing.correlation?.runId,
        ...credentialActorLogContext,
        assistantUserName: botConfig.userName,
        modelId: activeModelId,
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
          modelId: activeModelId,
          assistantMessageCount: 0,
          ...(reasoningSelection
            ? {
                reasoningLevel: reasoningSelection.reasoningLevel,
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
