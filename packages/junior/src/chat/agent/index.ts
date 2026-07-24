/**
 * Agent executor.
 *
 * Composition root and execution loop for one agent run slice after
 * runtime/ingress code has parsed and routed the request. Wires the phase
 * modules (session restore, skills, tools, prompt, resume), runs the Pi
 * agent with the inline provider retry loop, and translates expected run
 * endings into `AgentRunOutcome` values. It emits every completed, tool-free
 * visible assistant message through the delivery port; the result carries
 * diagnostics, artifacts, and transcript state for destination-owned
 * completion.
 */
import { Agent, type AgentLoopTurnUpdate } from "@earendil-works/pi-agent-core";
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
  withLogContext,
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
  type ConversationMessageProvenance,
} from "@/chat/conversations/provenance";
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
  extractAssistantText,
  isAssistantMessage,
  retainRuntimeTurnContext,
} from "@/chat/pi/transcript";
import { createTracedStreamFn } from "@/chat/pi/traced-stream";
import { shouldEmitDevAgentTrace } from "@/chat/runtime/dev-agent-trace";
import {
  isTurnInputCommitLostError,
  type CooperativeTurnYieldError,
} from "@/chat/runtime/turn";
import type { AgentRunOutcome } from "@/chat/runtime/agent-run-outcome";
import {
  buildTurnResult,
  getAssistantMessageText,
} from "@/chat/services/turn-result";
import { isProviderRetryError } from "@/chat/services/provider-error";
import { nextProviderRetry } from "@/chat/services/provider-retry";
import { annotateTurnDeadlineToolResult } from "@/chat/tool-support/turn-deadline-result";
import {
  configuredTurnRoute,
  selectTurnRoute,
  toPiReasoningLevel,
  type TurnRoute,
} from "@/chat/services/turn-router";
import {
  addAgentTurnUsage,
  hasAgentTurnUsage,
  type AgentTurnUsage,
} from "@/chat/usage";
import {
  AuthPausePersistenceError,
  AuthorizationFlowDisabledError,
  AuthorizationPauseError,
} from "@/chat/services/auth-pause";
import {
  resolveConversationPrivacy,
  runWithConversationPrivacy,
  toCanonicalOutputMessage,
  toGenAiMessagesTraceAttributes,
  type ConversationPrivacy,
} from "@/chat/conversation-privacy";
import {
  RetryableDeliveryError,
  assertRunRoutingConsistency,
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
  profileConfig,
  type ModelProfile,
} from "@/chat/model-profile";
import { compactContextForHandoff } from "@/chat/services/context-compaction";
import { HANDOFF_TOOL_NAME } from "@/chat/tools/handoff/tool";

const AGENT_ABORT_SETTLE_GRACE_MS = 5_000;

/** Preserve delivery-error ownership across the agent generation boundary. */
class AssistantMessageDeliveryError extends Error {
  constructor(readonly originalError: unknown) {
    super("Assistant message delivery failed");
  }
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
  if (!request.routing.destination) {
    throw new TypeError("Assistant reply generation requires a destination");
  }
  const channelId =
    request.routing.destination.platform === "slack"
      ? request.routing.destination.channelId
      : undefined;
  const conversationPrivacy = resolveConversationPrivacy({
    channelId,
    conversationId: request.conversationId,
    // Destination visibility is provider-neutral. Slack event context remains
    // a compatibility fallback for callers that have not projected it yet.
    visibility:
      request.routing.destinationVisibility ??
      request.routing.slackConversation?.visibility,
  });
  const credentialActor = request.routing.credentialContext?.actor;
  const actor = actorFromRouting(request.routing);
  const userActor = actor && "userId" in actor ? actor : undefined;
  const runLogContext: LogContext = {
    conversationId: request.conversationId,
    platform: request.routing.source.platform,
    messageConversationId:
      request.routing.source.platform === "slack"
        ? request.conversationId
        : request.routing.source.conversationId,
    destinationName:
      request.routing.destination.platform === "slack"
        ? request.routing.destination.channelId
        : request.routing.destination.conversationId,
    userId: userActor?.userId,
    userName: userActor?.userName,
    userEmail: userActor?.email,
    runId: request.runId,
    actorType: credentialActor
      ? "type" in credentialActor
        ? credentialActor.type
        : "system"
      : undefined,
    actorId: credentialActor
      ? "type" in credentialActor
        ? credentialActor.userId
        : credentialActor.name
      : undefined,
    assistantUserName: botConfig.userName,
  };
  return withLogContext(runLogContext, () =>
    runWithConversationPrivacy(conversationPrivacy ?? "private", () =>
      executeAgentRunInPrivacyContext(
        request,
        conversationPrivacy,
        runLogContext,
      ),
    ),
  );
}

async function executeAgentRunInPrivacyContext(
  request: AgentRunRequest,
  conversationPrivacy: ConversationPrivacy | undefined,
  runLogContext: LogContext,
): Promise<AgentRunOutcome> {
  const { conversationId, input, routing, runId, turnId } = request;
  const policy = request.policy ?? {};
  const signal = policy.signal;
  const state = request.state ?? {};
  const observers = request.observers ?? {};
  const delivery = request.delivery;
  const durability = request.durability ?? {};

  signal?.throwIfAborted();

  assertRunRoutingConsistency(request);

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
  let lastKnownSandboxRef = state.sandboxRef;
  let mcpToolManager: McpToolManager | undefined;
  let connectedMcpProviders = new Set<string>();
  let turnUsage: AgentTurnUsage | undefined;
  let handoffPhaseUsage: AgentTurnUsage | undefined;
  const configuredReasoningLevel =
    policy.reasoningLevel ?? botConfig.reasoningLevel;
  let turnRoute: TurnRoute | undefined = configuredReasoningLevel
    ? configuredTurnRoute(
        STANDARD_MODEL_PROFILE,
        configuredReasoningLevel,
        policy.reasoningLevel ? "agent_config" : "default",
      )
    : undefined;
  let activeModelProfile: ModelProfile = STANDARD_MODEL_PROFILE;
  let activeModelId = modelIdForProfile(botConfig, activeModelProfile);
  const actor = actorFromRouting(routing);
  const surface = surfaceFromRouting(routing);
  const runSource = routing.source;
  const slackSource = runSource.platform === "slack" ? runSource : undefined;
  const slackDestination =
    routing.destination.platform === "slack" ? routing.destination : undefined;
  const slackActor = actor?.platform === "slack" ? actor : undefined;
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
    threadId: slackSource ? conversationId : undefined,
    actorId: slackActor?.userId,
    channelId: slackDestination?.channelId,
    runId,
    ...credentialActorLogContext,
    assistantUserName: botConfig.userName,
  };
  const recordConnectedMcpProvider = async (provider: string) => {
    if (connectedMcpProviders.has(provider)) {
      return;
    }
    await recordMcpProviderConnected({
      conversationId,
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
  try {
    const projection = await openConversationProjection({ conversationId });
    activeModelProfile = projection.modelProfile;
    activeModelId = modelIdForProfile(botConfig, activeModelProfile);
    const shouldTrace = shouldEmitDevAgentTrace();
    const spanContext: LogContext = { modelId: activeModelId };

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
          "messaging.message.id": slackSource?.messageTs ?? "",
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
    } = await restoreSessionRecord({
      conversationId,
      turnId,
    });
    // Mirror the committed provenance prefix the turn session record owns. A
    // fresh run may already include batched parked input committed before the
    // agent starts, then adds the current actor's turn-start instruction.
    // Steering appends to this array as it drains, so `run.actors` stays a
    // pure, live projection of committed instruction provenance.
    const committedInstructionProvenance: ConversationMessageProvenance[] = [
      ...(existingSessionRecord?.piMessageProvenance ?? []),
      ...(existingSessionRecord?.actors ?? []).map(instructionProvenanceFor),
      ...(resumedFromSessionRecord ? [] : [instructionProvenanceFor(actor)]),
    ];
    const runActors = (): Actor[] =>
      instructionActors(committedInstructionProvenance);
    resume = createResumeState({
      channelName: routing.slackConversation?.name,
      destination: routing.destination,
      durability,
      getLoadedSkillNames: () => loadedSkillNamesForResume,
      getReasoningLevel: () => turnRoute?.reasoningLevel,
      logContext: sessionRecordLogContext,
      getModelId: () => activeModelId,
      recordActiveMcpProviders,
      actor,
      runSource,
      conversationId,
      turnId,
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
      try {
        await recordToolExecutionStarted({
          conversationId,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
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
      await loadConnectedMcpProviders({ conversationId }),
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

    if (activeModelProfile === STANDARD_MODEL_PROFILE) {
      turnRoute = await selectTurnRoute({
        completeObject,
        conversationContext: input.conversationContext,
        context: {
          threadId: conversationId,
          channelId: slackDestination?.channelId,
          actorId: slackActor?.userId,
          runId,
        },
        currentTurnBlocks: routerBlocks,
        fastModelId: botConfig.fastModelId,
        messageText: userInput,
        profiles: botConfig.profiles,
      });
      if (configuredReasoningLevel) {
        turnRoute = {
          ...turnRoute,
          reasoningLevel: configuredReasoningLevel,
          reason: `configured:${policy.reasoningLevel ? "agent_config" : "default"}:${turnRoute.reason}`,
        };
      }
    } else {
      const activeProfileConfig = profileConfig(botConfig, activeModelProfile);
      turnRoute = configuredTurnRoute(
        activeModelProfile,
        activeProfileConfig.reasoningLevel ??
          policy.reasoningLevel ??
          botConfig.reasoningLevel ??
          "medium",
        activeProfileConfig.reasoningLevel
          ? "profile"
          : policy.reasoningLevel
            ? "agent_config"
            : "default",
      );
    }

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
      ...Object.keys(botConfig.profiles)
        .filter(
          (profile) =>
            profile !== STANDARD_MODEL_PROFILE &&
            profile !== DEFAULT_HANDOFF_MODEL_PROFILE,
        )
        .sort(),
    ];
    /** Commit the durable handoff epoch before staging its in-memory model swap. */
    const scheduleHandoff = async (args: {
      profile: ModelProfile;
      runtimeContextSourceMessages?: PiMessage[];
      signal?: AbortSignal;
      sourceMessages: PiMessage[];
      triggeringToolCallId?: string;
    }) => {
      if (args.profile === activeModelProfile) {
        return;
      }
      const runtimeContext = retainRuntimeTurnContext(
        args.runtimeContextSourceMessages ?? args.sourceMessages,
      );
      const standardPhaseUsage = extractGenAiUsageSummary(
        ...args.sourceMessages
          .slice(runResume.beforeMessageCount)
          .filter(isAssistantMessage),
      );
      const phaseUsage = hasAgentTurnUsage(standardPhaseUsage)
        ? standardPhaseUsage
        : undefined;
      const selectedProfile = profileConfig(botConfig, args.profile);
      const handoffReasoningLevel =
        selectedProfile.reasoningLevel ?? turnRoute!.reasoningLevel;
      const target = {
        modelId: selectedProfile.modelId,
        modelProfile: args.profile,
        reasoningLevel: handoffReasoningLevel,
      };
      const handoffModel = resolveGatewayModel(target.modelId);
      const handoffThinkingLevel = toPiReasoningLevel(handoffReasoningLevel);
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
          conversationId,
          piMessages: args.sourceMessages,
          runtimeContext,
          signal: args.signal,
          triggeringToolCallId: args.triggeringToolCallId,
          target,
          metadata: {
            threadId: conversationId,
            channelId: slackDestination?.channelId,
            actorId: slackActor?.userId,
            runId,
          },
        },
        { completeText },
      );
      if (handoffReasoningLevel !== turnRoute!.reasoningLevel) {
        turnRoute = {
          ...turnRoute!,
          reasoningLevel: handoffReasoningLevel,
          reason: `profile_reasoning_override:${args.profile}:${turnRoute!.reason}`,
        };
      }
      handoffPhaseUsage = phaseUsage;
      pendingHandoff = {
        messages: handoffMessages,
        model: handoffModel,
        thinkingLevel: handoffThinkingLevel,
      };
      activeModelProfile = args.profile;
      activeModelId = target.modelId;
    };
    const requestHandoff = {
      profiles: handoffProfiles,
      execute: async (
        profile: ModelProfile,
        options: { signal?: AbortSignal; toolCallId: string },
      ) =>
        await scheduleHandoff({
          profile,
          signal: options.signal,
          sourceMessages: [...agent!.state.messages],
          triggeringToolCallId: options.toolCallId,
        }),
    };

    setTags({
      ...runLogContext,
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
      onSandboxRefChanged: (sandboxRef) => {
        lastKnownSandboxRef = sandboxRef;
      },
      policy,
      preAgentPromptMessages,
      priorPiMessages,
      recordConnectedMcpProvider,
      requestHandoff,
      resume: runResume,
      routing,
      conversationId,
      turnId,
      skillSandbox,
      spanContext,
      state,
      surface,
      syncLoadedSkillNamesForResume,
      toolCalls,
      userInput,
    });
    mcpToolManager = wiring.mcpToolManager;
    const getPendingAuthPause = wiring.getPendingAuthPause;
    const toolsAfterHandoff = wiring.agentTools;

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
    /** Apply a committed handoff to Pi and reset its durable resume baseline. */
    const applyPendingHandoff = (): AgentLoopTurnUpdate | undefined => {
      if (!pendingHandoff) {
        return undefined;
      }
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
        "gen_ai.agent.reasoning.level": turnRoute!.reasoningLevel,
      });
      return {
        context: {
          systemPrompt: baseInstructions,
          messages: replacement,
          tools: toolsAfterHandoff,
        },
        model,
        thinkingLevel,
      };
    };
    // ── Agent execution ──────────────────────────────────────────────
    let assistantMessageDeliveryError:
      | AssistantMessageDeliveryError
      | undefined;
    /** Deliver one completed tool-free visible message before the agent advances. */
    const deliverAssistantMessage = async (
      message: Parameters<typeof extractAssistantText>[0],
    ): Promise<void> => {
      const text = getAssistantMessageText(message);
      if (!text || !delivery) {
        return;
      }
      try {
        await delivery.onAssistantMessage({ text });
      } catch (error) {
        assistantMessageDeliveryError = new AssistantMessageDeliveryError(
          error,
        );
        throw assistantMessageDeliveryError;
      }
    };
    const drainSteeringMessages = async (): Promise<void> => {
      if (!durability.drainSteeringMessages) {
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
    // Pi converts prepareNextTurn exceptions into error turns instead of
    // rejecting. Preserve Junior's yield so runAgentStep can restore it after
    // the Pi run settles without leaking Pi mechanics into the resume API.
    let pendingPiHookError: CooperativeTurnYieldError | undefined;
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
      afterToolCall: async ({ result }, signal) =>
        runResume.timedOut && signal?.aborted
          ? annotateTurnDeadlineToolResult(result)
          : undefined,
      prepareNextTurn: async () => {
        const update = applyPendingHandoff();
        await drainSteeringMessages();
        const yieldError = runResume.prepareYieldIfDue(currentAgentMessages());
        if (yieldError) {
          pendingPiHookError = yieldError;
          throw yieldError;
        }
        return update;
      },
      initialState: {
        systemPrompt: baseInstructions,
        model: resolveGatewayModel(activeModelId),
        thinkingLevel: toPiReasoningLevel(turnRoute.reasoningLevel),
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
      if (event.type === "message_end" && isAssistantMessage(event.message)) {
        if (
          event.message.stopReason === "error" ||
          event.message.stopReason === "aborted"
        ) {
          return;
        }
        const containsHandoff = event.message.content.some(
          (part) => part.type === "toolCall" && part.name === HANDOFF_TOOL_NAME,
        );
        if (containsHandoff) {
          return;
        }
        return deliverAssistantMessage(event.message);
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

      const authPauseOutcome = await withSpan(
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

          /** Race one provider operation against the turn deadline and abort its owner. */
          const runAgentStep = async (
            run: Promise<unknown>,
            abortRun: () => void = () => agent!.abort(),
          ): Promise<unknown> => {
            let timeoutId: ReturnType<typeof setTimeout> | undefined;
            let removeAbortListener: (() => void) | undefined;
            const timeoutPromise = new Promise<never>((_, reject) => {
              const rejectWithTimeout = () => {
                runResume.markTimedOut();
                abortRun();
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
                    abortRun();
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

            let result: unknown;
            try {
              result = await Promise.race(
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
                    ...(turnRoute
                      ? {
                          "gen_ai.request.reasoning.level":
                            turnRoute.reasoningLevel,
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
              const pendingAuthPause = getPendingAuthPause();
              if (pendingAuthPause) {
                runResume.captureResumeSnapshot(
                  runResume.getResumeSnapshot(currentAgentMessages()),
                );
                throw pendingAuthPause;
              }
              throw error;
            } finally {
              if (timeoutId) {
                clearTimeout(timeoutId);
              }
              removeAbortListener?.();
            }
            if (pendingPiHookError) {
              const error = pendingPiHookError;
              pendingPiHookError = undefined;
              throw error;
            }
            return result;
          };

          const requestedProfile =
            activeModelProfile === STANDARD_MODEL_PROFILE
              ? turnRoute!.profile
              : undefined;
          let run: Promise<unknown>;
          if (requestedProfile && requestedProfile !== STANDARD_MODEL_PROFILE) {
            const handoffAbortController = new AbortController();
            await runAgentStep(
              scheduleHandoff({
                profile: requestedProfile,
                runtimeContextSourceMessages: shouldPromptAgent
                  ? [freshPromptMessage]
                  : undefined,
                signal: handoffAbortController.signal,
                sourceMessages: [...agent!.state.messages],
              }),
              () => handoffAbortController.abort(),
            );
            applyPendingHandoff();
            if (shouldPromptAgent) {
              await runResume.requireDurableInputCheckpoint([
                ...agent!.state.messages,
                freshPromptMessage,
              ]);
              run = agent!.prompt(freshPromptMessage);
            } else {
              run = agent!.continue();
            }
          } else {
            run = shouldPromptAgent
              ? agent!.prompt(freshPromptMessage)
              : agent!.continue();
          }
          let retryUsage: AgentTurnUsage | undefined;
          try {
            for (let attempt = 0; ; attempt += 1) {
              await runAgentStep(run);
              if (assistantMessageDeliveryError) {
                throw assistantMessageDeliveryError;
              }
              signal?.throwIfAborted();

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
              turnUsage = addAgentTurnUsage(
                handoffPhaseUsage,
                currentPhaseUsage,
              );
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
              const pendingAuthPause = getPendingAuthPause();
              if (pendingAuthPause) {
                runResume.captureResumeSnapshot(
                  runResume.getResumeSnapshot(currentAgentMessages()),
                );
                throw pendingAuthPause;
              }

              const providerRetry = nextProviderRetry({
                attempt,
                failure: lastAssistant,
                messages: agent!.state.messages,
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
          } catch (error) {
            if (error instanceof AuthorizationPauseError) {
              // A durable auth pause is a successful span outcome. Persistence
              // failures throw and remain terminal at the outer boundary.
              return await runResume.parkForAuth(error, turnUsage);
            }
            throw error;
          }
        },
        {
          "gen_ai.operation.name": "invoke_agent",
          "gen_ai.agent.model": activeModelId,
          "gen_ai.agent.model_profile": activeModelProfile,
          "gen_ai.agent.reasoning.level": turnRoute.reasoningLevel,
          "gen_ai.agent.reasoning.level_reason": turnRoute.reason,
          ...(turnRoute.confidence !== undefined
            ? {
                "gen_ai.agent.reasoning.level_confidence": turnRoute.confidence,
              }
            : {}),
          "gen_ai.output.type": "text",
          ...(conversationPrivacy
            ? { "app.conversation.privacy": conversationPrivacy }
            : {}),
          "app.ai.session.conversation_id": conversationId,
          "app.ai.turn.session_id": turnId,
          ...(currentSliceId ? { "app.ai.turn.slice_id": currentSliceId } : {}),
          ...toGenAiMessagesTraceAttributes("gen_ai.input", inputMessages),
          ...(inputMessagesAttribute
            ? { "gen_ai.input.messages": inputMessagesAttribute }
            : {}),
        },
      );
      if (authPauseOutcome) {
        return authPauseOutcome;
      }
    } finally {
      unsubscribe();
    }

    await recordActiveMcpProviders();
    // Generation completing is not durable completion: the session record
    // stays at its latest running safe boundary here. The destination owns the
    // completed session record after assistant output handling settles, so a
    // crash before that commit remains recoverable as a stranded run.

    // ── Build turn result ────────────────────────────────────────────
    const result = buildTurnResult({
      newMessages,
      userInput,
      artifactStatePatch,
      toolCalls,
      sandboxRef: wiring.getSandboxRef(),
      piMessages: [...agent.state.messages],
      durationMs: Date.now() - replyStartedAtMs,
      generatedFileCount: generatedFiles.length,
      shouldTrace,
      spanContext,
      usage: turnUsage,
      executionProfile: turnRoute,
      assistantUserName: botConfig.userName,
      modelId: activeModelId,
    });
    return {
      status: "completed",
      result,
    };
  } catch (error) {
    if (
      error instanceof AssistantMessageDeliveryError &&
      !(error.originalError instanceof RetryableDeliveryError)
    ) {
      throw error.originalError;
    }
    const runError =
      error instanceof AssistantMessageDeliveryError
        ? error.originalError
        : error;
    if (runError instanceof AuthPausePersistenceError) {
      throw runError;
    }
    if (resume && runError instanceof AuthorizationPauseError) {
      // Eager provider restoration can request auth before the agent span
      // exists; use the same durable parking operation as the in-span path.
      return await resume.parkForAuth(runError, turnUsage);
    }
    if (resume) {
      const outcome = await resume.translateSuspension({
        currentUsage: turnUsage,
        error: runError,
      });
      if (outcome) {
        return outcome;
      }
    }

    if (error instanceof AssistantMessageDeliveryError) {
      throw error.originalError;
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
      { modelId: activeModelId },
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
        sandboxRef: lastKnownSandboxRef,
        diagnostics: {
          outcome: "provider_error",
          modelId: activeModelId,
          assistantMessageCount: 0,
          ...(turnRoute
            ? {
                reasoningLevel: turnRoute.reasoningLevel,
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
