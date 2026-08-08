/**
 * Agent executor.
 *
 * Composition root and execution loop for one agent run slice after
 * runtime/ingress code has parsed and routed the request. Wires the phase
 * modules (session restore, skills, tools, prompt, resume), runs the Pi agent
 * with inline retry handling, and translates expected run endings into
 * `AgentRunOutcome` values. It emits every completed, tool-free visible
 * assistant message through the delivery port; the result carries diagnostics,
 * artifacts, and transcript state for destination-owned completion.
 */
import {
  Agent,
  type AgentLoopTurnUpdate,
  type StreamFn,
} from "@earendil-works/pi-agent-core";
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
  loadTurnRoute,
  openConversationProjection,
  recordAgentsInstructionsUpdated,
  recordToolExecutionStarted,
  recordMcpProviderConnected,
  recordTurnRoute,
} from "@/chat/conversations/projection";
import {
  instructionActors,
  instructionProvenanceFor,
  sameActorIdentity,
  type ConversationMessageProvenance,
} from "@/chat/conversations/provenance";
import type { Actor } from "@/chat/actor";
import {
  GEN_AI_PROVIDER_NAME,
  completeObject,
  completeText,
  getGatewayApiKey,
  resolveGatewayModel,
} from "@/chat/pi/client";
import type { PiMessage } from "@/chat/pi/messages";
import { renderAgentsInstructions } from "@/chat/repository-instructions";
import { createRepositoryInstructionsContext } from "@/chat/agent/repository-context";
import {
  extractAssistantText,
  getUserMessageInstructionText,
  isAssistantMessage,
  retainRuntimeTurnContext,
} from "@/chat/pi/transcript";
import { createTracedStreamFn } from "@/chat/pi/traced-stream";
import { shouldEmitDevAgentTrace } from "@/chat/runtime/dev-agent-trace";
import { isTurnInputCommitLostError } from "@/chat/runtime/turn";
import type { AgentRunOutcome } from "@/chat/runtime/agent-run-outcome";
import { buildTurnResult } from "@/chat/services/turn-result";
import { decideReply } from "@/chat/services/assistant-reply";
import {
  findProviderError,
  getProviderErrorAttributes,
  isProviderRetryError,
} from "@/chat/services/provider-error";
import { nextProviderRetry } from "@/chat/services/provider-retry";
import { nextEmptyOutputContinuation } from "@/chat/services/empty-output-continuation";
import { getDiscardedRetryUsage } from "@/chat/agent/retry-usage";
import { projectTimedOutToolResult } from "@/chat/tool-support/timed-out-tool-result";
import {
  configuredTurnRoute,
  selectTurnRoute,
  toPiReasoningLevel,
  type TurnRoute,
} from "@/chat/services/turn-router";
import { parseTurnReasoningLevel } from "@/chat/reasoning-level";
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
import { resolveDestinationVisibility } from "@/chat/conversations/destination-visibility";
import {
  RetryableDeliveryError,
  assertRunRoutingConsistency,
  actorFromRouting,
  isAgentRunFeatureDisabled,
  surfaceFromRouting,
  type AgentRunRequest,
} from "@/chat/agent/request";
import { actionConfirmationRetryMessages } from "@/chat/agent/action-confirmation-retry";
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
import {
  compactActiveContextIfNeeded,
  compactContextForHandoff,
} from "@/chat/services/context-compaction";
import {
  createHandoffTool,
  HANDOFF_TOOL_NAME,
} from "@/chat/tools/handoff/tool";

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

/**
 * Run a full agent turn, optionally using a caller-provided model stream.
 *
 * The stream changes model output only; prompt assembly, persistence, tools,
 * delivery, and completion still use the normal agent runtime.
 */
export async function executeAgentRun(
  request: AgentRunRequest,
  streamFn?: StreamFn,
): Promise<AgentRunOutcome> {
  if (!request.routing.destination) {
    throw new TypeError("Assistant reply generation requires a destination");
  }
  const destinationVisibility = await resolveDestinationVisibility({
    destination: request.routing.destination,
    visibility: request.routing.destinationVisibility,
  });
  const conversationPrivacy = resolveConversationPrivacy({
    visibility: destinationVisibility,
  });
  const resolvedRequest = destinationVisibility
    ? {
        ...request,
        routing: { ...request.routing, destinationVisibility },
      }
    : request;
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
    runWithConversationPrivacy(conversationPrivacy, () =>
      executeAgentRunInPrivacyContext(
        resolvedRequest,
        conversationPrivacy,
        runLogContext,
        streamFn,
      ),
    ),
  );
}

async function executeAgentRunInPrivacyContext(
  request: AgentRunRequest,
  conversationPrivacy: ConversationPrivacy | undefined,
  runLogContext: LogContext,
  streamFn: StreamFn | undefined,
): Promise<AgentRunOutcome> {
  const { conversationId, input, routing, runId, turnId } = request;
  const policy = request.policy ?? {};
  const signal = policy.signal;
  const state = request.state ?? {};
  const observers = request.observers ?? {};
  const delivery = request.delivery;
  const authorization = request.authorization;
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
  let closeTools: (() => Promise<void>) | undefined;
  let connectedMcpProviders = new Set<string>();
  let turnUsage: AgentTurnUsage | undefined;
  let priorPhaseUsage: AgentTurnUsage | undefined;
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
    let durableModelProfile = projection.modelProfile;
    const shouldTrace = shouldEmitDevAgentTrace();
    const spanContext: LogContext = { modelId: activeModelId };

    // ── Skill discovery ──────────────────────────────────────────────
    const availableSkills = await discoverRunSkills({
      skillDirs: policy.skillDirs,
    });
    if (shouldTrace) {
      const inboundAttachmentCount = input.inboundAttachmentCount ?? 0;
      const promptAttachmentCount = input.userAttachments?.length ?? 0;
      logInfo("agent.message.received", {
        "app.message.kind": "user_inbound",
        "app.message.length": userInput.length,
        "app.message.input": summarizeMessageText(userInput),
        // Log both counts so image uploads filtered by vision/config do not
        // look indistinguishable from Slack ingress dropping attachments.
        "app.message.attachment_count": inboundAttachmentCount,
        "app.message.prompt_attachment_count": promptAttachmentCount,
        "messaging.message.id": slackSource?.messageTs ?? "",
      });
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
    const turnStartMessageIndex = existingSessionRecord?.turnStartMessageIndex;
    const currentTurnMessages =
      turnStartMessageIndex !== undefined
        ? (existingSessionRecord?.piMessages.slice(turnStartMessageIndex) ?? [])
        : [];
    const currentTurnProvenance =
      turnStartMessageIndex !== undefined
        ? (existingSessionRecord?.piMessageProvenance?.slice(
            turnStartMessageIndex,
          ) ?? [])
        : [];
    const guardianIntentParts =
      currentTurnMessages.flatMap((message, index) => {
        const provenance = currentTurnProvenance[index];
        if (
          provenance?.authority !== "instruction" ||
          !sameActorIdentity(provenance.actor, actor)
        ) {
          return [];
        }
        const text = getUserMessageInstructionText(message);
        return text ? [text] : [];
      }) ?? [];
    if (!resumedFromSessionRecord || guardianIntentParts.length === 0) {
      guardianIntentParts.push(userInput);
    }
    const currentUserIntent = (): string => guardianIntentParts.join("\n\n");
    resume = createResumeState({
      channelName: routing.slackConversation?.name,
      destination: routing.destination,
      ...(routing.destinationVisibility
        ? { destinationVisibility: routing.destinationVisibility }
        : {}),
      ...(routing.dispatch?.id ? { dispatchId: routing.dispatch.id } : {}),
      durability,
      getLoadedSkillNames: () => loadedSkillNamesForResume,
      getReasoningLevel: () => turnRoute?.reasoningLevel,
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
        logException(error, "agent.turn.session_log_append.failed", {
          "gen_ai.tool.name": event.toolName,
        });
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
    const explicitSkill = invokedSkill
      ? (activeSkills.find((skill) => skill.name === invokedSkill.name) ?? null)
      : null;
    // ── Prompt input ─────────────────────────────────────────────────
    const { contextContentParts, routerBlocks, userContentParts } =
      buildPromptInput(input);
    const preAgentPromptMessages = (): PiMessage[] =>
      existingSessionRecord?.piMessages ?? [...(input.piMessages ?? [])];

    const handoffEnabled = !isAgentRunFeatureDisabled(policy, "handoff");
    const storedTurnRoute = await loadTurnRoute({ conversationId, turnId });
    if (storedTurnRoute) {
      const resumedAfterHandoff =
        handoffEnabled &&
        activeModelProfile !== STANDARD_MODEL_PROFILE &&
        activeModelProfile !== storedTurnRoute.modelProfile;
      if (resumedAfterHandoff) {
        const activeProfileConfig = profileConfig(
          botConfig,
          activeModelProfile,
        );
        const resumedReasoningLevel = existingSessionRecord?.reasoningLevel
          ? parseTurnReasoningLevel(existingSessionRecord.reasoningLevel)
          : undefined;
        turnRoute = {
          profile: activeModelProfile,
          reasoningLevel:
            activeProfileConfig.reasoningLevel ??
            resumedReasoningLevel ??
            storedTurnRoute.reasoningLevel,
          reason: `resumed_handoff:${storedTurnRoute.modelProfile}:${activeModelProfile}`,
        };
      } else {
        turnRoute = {
          profile: storedTurnRoute.modelProfile,
          reasoningLevel: storedTurnRoute.reasoningLevel,
          ...(storedTurnRoute.confidence !== undefined
            ? { confidence: storedTurnRoute.confidence }
            : {}),
          reason: `persisted:${storedTurnRoute.source}`,
          source: storedTurnRoute.source,
        };
      }
    } else if (
      activeModelProfile === STANDARD_MODEL_PROFILE &&
      handoffEnabled
    ) {
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
      const routedProfileReasoningLevel = profileConfig(
        botConfig,
        turnRoute.profile,
      ).reasoningLevel;
      if (configuredReasoningLevel && !routedProfileReasoningLevel) {
        turnRoute = {
          ...turnRoute,
          reasoningLevel: configuredReasoningLevel,
          reason: `configured:${policy.reasoningLevel ? "agent_config" : "default"}:${turnRoute.reason}`,
        };
      }
    } else if (!handoffEnabled) {
      const activeProfileConfig = profileConfig(botConfig, activeModelProfile);
      const reasoningSource = policy.reasoningLevel
        ? "agent_config"
        : activeProfileConfig.reasoningLevel
          ? "profile"
          : "default";
      turnRoute = {
        profile: activeModelProfile,
        reasoningLevel:
          policy.reasoningLevel ??
          activeProfileConfig.reasoningLevel ??
          botConfig.reasoningLevel ??
          "medium",
        reason: `fixed:${reasoningSource}`,
        source: "configured",
      };
    } else {
      const activeProfileConfig = profileConfig(botConfig, activeModelProfile);
      const reasoningSource = activeProfileConfig.reasoningLevel
        ? "profile"
        : policy.reasoningLevel
          ? "agent_config"
          : "default";
      turnRoute = {
        profile: activeModelProfile,
        reasoningLevel:
          activeProfileConfig.reasoningLevel ??
          policy.reasoningLevel ??
          botConfig.reasoningLevel ??
          "medium",
        reason: `inherited:${reasoningSource}`,
        source: "inherited",
      };
    }

    const routedModelProfile = turnRoute.profile;
    const routedModelId = modelIdForProfile(botConfig, routedModelProfile);
    if (!storedTurnRoute) {
      await recordTurnRoute({
        conversationId,
        turnId,
        modelProfile: routedModelProfile,
        modelId: routedModelId,
        reasoningLevel: turnRoute.reasoningLevel,
        ...(turnRoute.confidence !== undefined
          ? { confidence: turnRoute.confidence }
          : {}),
        source: turnRoute.source ?? "configured",
      });
    }
    activeModelProfile = routedModelProfile;
    activeModelId = routedModelId;

    // ── Mutable turn state ───────────────────────────────────────────
    const generatedFiles: FileUpload[] = [];
    const artifactStatePatch: Partial<ThreadArtifactsState> = {};
    const toolCalls: string[] = [];
    let agent: Agent | undefined;
    let pendingPiHookError: Error | undefined;
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
    const usageSinceCurrentBoundary = (
      messages: PiMessage[],
    ): AgentTurnUsage | undefined => {
      const usage = extractGenAiUsageSummary(
        ...messages
          .slice(runResume.beforeMessageCount)
          .filter(isAssistantMessage),
      );
      return hasAgentTurnUsage(usage) ? usage : undefined;
    };
    /** Commit the durable handoff epoch before staging its in-memory model swap. */
    const scheduleHandoff = async (args: {
      profile: ModelProfile;
      runtimeContextSourceMessages?: PiMessage[];
      signal?: AbortSignal;
      sourceMessages: PiMessage[];
      triggeringToolCallId?: string;
    }) => {
      if (args.profile === durableModelProfile) {
        return;
      }
      const runtimeContext = retainRuntimeTurnContext(
        args.runtimeContextSourceMessages ?? args.sourceMessages,
      );
      const phaseUsage = usageSinceCurrentBoundary(args.sourceMessages);
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
        logWarn("assistant.status.observer.failed", {
          "exception.message":
            error instanceof Error ? error.message : String(error),
        });
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
        {
          completeText: (args) => completeText(args),
        },
      );
      durableModelProfile = args.profile;
      if (handoffReasoningLevel !== turnRoute!.reasoningLevel) {
        turnRoute = {
          ...turnRoute!,
          reasoningLevel: handoffReasoningLevel,
          reason: `profile_reasoning_override:${args.profile}:${turnRoute!.reason}`,
        };
      }
      priorPhaseUsage = addAgentTurnUsage(priorPhaseUsage, phaseUsage);
      pendingHandoff = {
        messages: handoffMessages,
        model: handoffModel,
        thinkingLevel: handoffThinkingLevel,
      };
      activeModelProfile = args.profile;
      activeModelId = target.modelId;
    };
    const handoffControlFor = (activeProfile: ModelProfile) => {
      const profiles = handoffProfiles.filter(
        (profile) => profile !== activeProfile,
      );
      return profiles.length > 0
        ? {
            profiles: profiles as [ModelProfile, ...ModelProfile[]],
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
          }
        : undefined;
    };
    const requestHandoff = handoffEnabled
      ? handoffControlFor(activeModelProfile)
      : undefined;

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
      currentAgentMessages,
      currentTurnMessages,
      currentUserIntent,
      artifactStatePatch,
      availableSkills,
      configurationValues,
      connectedMcpProviders,
      conversationPrivacy,
      durability,
      authorization,
      generatedFiles,
      invokedSkill,
      observers,
      onFatalToolError(error) {
        pendingPiHookError = error;
        agent?.abort();
      },
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
      supportsImageInput: () =>
        resolveGatewayModel(activeModelId).input.includes("image"),
      surface,
      syncLoadedSkillNamesForResume,
      toolCalls,
      userInput,
    });
    mcpToolManager = wiring.mcpToolManager;
    closeTools = wiring.close;
    const initialRepositoryInstructions = wiring.getSandboxRef()
      ? await wiring.captureRepositoryInstructions()
      : undefined;
    const recordAgentsTransition = async (
      instructions: typeof initialRepositoryInstructions,
    ) => {
      try {
        await recordAgentsInstructionsUpdated({
          conversationId,
          instructions,
          turnId,
        });
      } catch (error) {
        // Host-only transcript markers are best-effort reporting writes; a
        // failed append must not abort the in-flight model turn.
        logException(error, "agent.agents_instructions_event.append.failed");
      }
    };
    if (initialRepositoryInstructions) {
      await recordAgentsTransition(initialRepositoryInstructions);
    }
    const getPendingAuthPause = wiring.getPendingAuthPause;
    const toolsWithoutHandoff = wiring.agentTools.filter(
      (tool) => tool.name !== HANDOFF_TOOL_NAME,
    );
    const handoffAgentTool = wiring.agentTools.find(
      (tool) => tool.name === HANDOFF_TOOL_NAME,
    );
    const toolsForActiveProfile = () => {
      const handoff = handoffEnabled
        ? handoffControlFor(activeModelProfile)
        : undefined;
      if (!handoff) {
        return toolsWithoutHandoff;
      }
      if (!handoffAgentTool) {
        throw new Error("Handoff control is missing its Pi tool");
      }
      const definition = createHandoffTool(handoff);
      return wiring.agentTools.map((tool) =>
        tool.name === HANDOFF_TOOL_NAME
          ? {
              ...handoffAgentTool,
              description: definition.description,
              parameters: definition.inputSchema,
              prepareArguments: definition.prepareArguments,
            }
          : tool,
      );
    };

    // ── Prompt context ───────────────────────────────────────────────
    const {
      baseInstructions,
      contextContentParts: promptContextContentParts,
      inputMessages,
      inputMessagesAttribute,
      promptTimestamp: restoredPromptTimestamp,
      promptHistoryMessages,
      shouldPromptAgent,
      turnContexts,
      userContentParts: promptUserContentParts,
    } = await assemblePrompt({
      activeMcpCatalogs: wiring.activeMcpCatalogs,
      currentActor: actor,
      artifactState: state.artifactState,
      availableSkills,
      configurationValues,
      contextContentParts: [
        ...(initialRepositoryInstructions
          ? [
              {
                type: "text" as const,
                text: renderAgentsInstructions(initialRepositoryInstructions),
              },
            ]
          : []),
        ...contextContentParts,
      ],
      conversationPrivacy,
      existingSessionPiMessages: existingSessionRecord?.piMessages,
      existingTurnStartMessageIndex:
        existingSessionRecord?.turnStartMessageIndex,
      explicitSkill,
      priorPiMessages,
      resumedFromSessionRecord,
      routing,
      spanContext,
      turnId,
      toolGuidance: wiring.toolGuidance,
      toolRuntimeContext: wiring.toolRuntimeContext,
      userContentParts,
    });
    const repositoryInstructionsContext = createRepositoryInstructionsContext({
      capture: wiring.captureRepositoryInstructions,
      hasSandbox: () => Boolean(wiring.getSandboxRef()),
      initialInstructions: initialRepositoryInstructions,
      onTransition: recordAgentsTransition,
      promptContextContentParts,
      restoredMessages: existingSessionRecord?.piMessages,
      restoredProvenance: existingSessionRecord?.piMessageProvenance,
      setMessages(messages) {
        agent!.state.messages = messages;
      },
      shouldPromptAgent,
    });
    runResume.setTurnContexts(turnContexts);
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
      const tools = toolsForActiveProfile();
      agent!.state.tools = tools;
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
          tools,
        },
        model,
        thinkingLevel,
      };
    };
    /** Commit and adopt an active capacity replacement before another model call. */
    const applyActiveContextCompaction = async (
      messages: PiMessage[],
      hookSignal?: AbortSignal,
      pendingMessages?: Array<{
        message: PiMessage;
        provenance: ConversationMessageProvenance;
      }>,
      clearSteeringQueueOnCommit = false,
      pairPendingRuntimeContext = false,
    ): Promise<AgentLoopTurnUpdate | undefined> => {
      const compaction = await compactActiveContextIfNeeded(
        {
          conversationContext: input.conversationContext,
          conversationId,
          metadata: {
            threadId: conversationId,
            channelId: slackDestination?.channelId,
            actorId: slackActor?.userId,
            runId,
          },
          modelId: activeModelId,
          modelProfile: activeModelProfile,
          onCompactionStart: () =>
            observers.onStatus?.({ text: "Compacting context" }),
          pendingMessages,
          piMessages: messages,
          ...(pairPendingRuntimeContext && pendingMessages
            ? {
                runtimeContextMessages: [
                  ...messages,
                  ...pendingMessages.map((entry) => entry.message),
                ],
              }
            : {}),
          signal: hookSignal,
        },
        {
          completeText: (args) => completeText(args),
        },
      );
      if (!compaction.compacted || !compaction.piMessages) {
        return undefined;
      }

      priorPhaseUsage = addAgentTurnUsage(
        priorPhaseUsage,
        usageSinceCurrentBoundary(messages),
      );
      const replacement = [...compaction.piMessages];
      await runResume.requireDurableInputCheckpoint(replacement);
      agent!.state.messages = replacement;
      runResume.setBeforeMessageCount(replacement.length);
      runResume.setTurnStartMessageIndex(0);
      runResume.adoptCommittedBoundary(replacement);
      if (clearSteeringQueueOnCommit && pendingMessages?.length) {
        agent!.clearSteeringQueue();
      }
      return {
        context: {
          systemPrompt: baseInstructions,
          messages: replacement,
          tools: agent!.state.tools,
        },
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
      const decision = decideReply(message);
      if (decision.kind !== "deliver" || !delivery) {
        return;
      }
      try {
        await delivery(message);
      } catch (error) {
        assistantMessageDeliveryError = new AssistantMessageDeliveryError(
          error,
        );
        throw assistantMessageDeliveryError;
      }
    };
    const drainSteeringMessages = async (): Promise<
      Array<{
        message: PiMessage;
        provenance: ConversationMessageProvenance;
      }>
    > => {
      if (!durability.drainSteeringMessages) {
        return [];
      }

      const acceptedMessages: Array<{
        message: PiMessage;
        provenance: ConversationMessageProvenance;
      }> = [];
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
          for (const message of messages) {
            if (
              message.provenance.authority === "instruction" &&
              sameActorIdentity(message.provenance.actor, actor) &&
              message.text.trim()
            ) {
              guardianIntentParts.push(message.text.trim());
            }
          }
          for (const message of piMessages) {
            agent!.steer(message);
          }
          acceptedMessages.push(
            ...piMessages.map((message, index) => ({
              message,
              provenance: messages[index]!.provenance,
            })),
          );
          steeredMessageCount += piMessages.length;
        });
        if (steeredMessageCount > 0) {
          logInfo("agent.turn.steering_messages.accepted", {
            "app.ai.steering_message_count": steeredMessageCount,
          });
        }
      } catch (error) {
        if (isTurnInputCommitLostError(error)) {
          throw error;
        }
        logWarn("agent.turn.steering_messages_drain.failed", {
          "exception.message":
            error instanceof Error ? error.message : String(error),
        });
      }
      return acceptedMessages;
    };

    // Pi converts prepareNextTurn exceptions into error turns instead of
    // rejecting. Preserve Junior's yield so runAgentStep can restore it after
    // the Pi run settles without leaking Pi mechanics into the resume API.
    agent = new Agent({
      // Resolve on every provider call so runtime OIDC tokens stay fresh.
      getApiKey: getGatewayApiKey,
      streamFn: createTracedStreamFn({
        conversationPrivacy,
        ...(streamFn ? { base: streamFn } : {}),
      }),
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
      afterToolCall: async ({ result, toolCall }, signal) => {
        // Host continuity is session-owned (`resumeReason: "timeout"` + auto
        // continue). If this slice aborted a tool, record only that the attempt
        // timed out — not cancelled/deadline jargon.
        const sourceResult =
          runResume.timedOut && signal?.aborted
            ? (projectTimedOutToolResult(result) ?? result)
            : result;
        const projectedResult = wiring.projectActionReviewResult(
          toolCall.id,
          sourceResult,
        );
        return projectedResult !== result ? projectedResult : undefined;
      },
      prepareNextTurnWithContext: async (nextTurn, hookSignal) => {
        try {
          const handoffUpdate = applyPendingHandoff();
          const pendingMessages = await drainSteeringMessages();
          const capacityUpdate = await applyActiveContextCompaction(
            handoffUpdate
              ? currentAgentMessages()
              : (nextTurn.context.messages as PiMessage[]),
            hookSignal,
            pendingMessages,
            true,
          );
          const combinedUpdate =
            capacityUpdate && handoffUpdate
              ? { ...handoffUpdate, ...capacityUpdate }
              : (capacityUpdate ?? handoffUpdate);
          const repositoryInstructionsUpdate =
            await repositoryInstructionsContext.applyUpdate(
              combinedUpdate,
              nextTurn.context,
            );
          const yieldError = runResume.prepareYieldIfDue(
            currentAgentMessages(),
          );
          if (yieldError) {
            throw yieldError;
          }
          return repositoryInstructionsUpdate;
        } catch (error) {
          pendingPiHookError ??=
            error instanceof Error ? error : new Error(String(error));
          throw error;
        }
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
          const promptTimestamp = restoredPromptTimestamp ?? Date.now();
          const contextMessage: PiMessage | undefined =
            shouldPromptAgent && promptContextContentParts.length > 0
              ? ({
                  role: "user",
                  content: promptContextContentParts,
                  timestamp: promptTimestamp,
                } as PiMessage)
              : undefined;
          const freshPromptMessage: PiMessage = {
            role: "user",
            content: promptUserContentParts,
            timestamp: promptTimestamp,
          } as PiMessage;
          if (shouldPromptAgent) {
            const promptPersisted =
              await runResume.requireDurableInputCheckpoint([
                ...agent!.state.messages,
                ...(contextMessage ? [contextMessage] : []),
                freshPromptMessage,
              ]);
            if (promptPersisted) {
              await runResume.commitInput();
            }
          }
          if (contextMessage) {
            agent!.state.messages = [...agent!.state.messages, contextMessage];
          }
          if (!shouldPromptAgent) {
            await repositoryInstructionsContext.applyUpdate(undefined, {
              messages: agent!.state.messages,
              systemPrompt: agent!.state.systemPrompt,
              tools: agent!.state.tools,
            });
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
                logWarn("agent.turn.timed_out", {
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
                });
                const settled = await waitForAbortSettlement(
                  run,
                  AGENT_ABORT_SETTLE_GRACE_MS,
                );
                if (!settled) {
                  logWarn("agent.turn.abort_settle.timed_out", {
                    "app.ai.abort_settle_grace_ms": AGENT_ABORT_SETTLE_GRACE_MS,
                  });
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
          let handoffApplied = false;
          if (requestedProfile && requestedProfile !== STANDARD_MODEL_PROFILE) {
            const handoffAbortController = new AbortController();
            await runAgentStep(
              scheduleHandoff({
                profile: requestedProfile,
                runtimeContextSourceMessages: shouldPromptAgent
                  ? [
                      ...(contextMessage ? [contextMessage] : []),
                      freshPromptMessage,
                    ]
                  : undefined,
                signal: handoffAbortController.signal,
                sourceMessages: [...agent!.state.messages],
              }),
              () => handoffAbortController.abort(),
            );
            handoffApplied = Boolean(applyPendingHandoff());
          }
          const compactionAbortController = new AbortController();
          const capacityUpdate = await runAgentStep(
            applyActiveContextCompaction(
              [...agent!.state.messages],
              compactionAbortController.signal,
              shouldPromptAgent
                ? [
                    {
                      message: freshPromptMessage,
                      provenance: instructionProvenanceFor(actor),
                    },
                  ]
                : undefined,
              false,
              Boolean(contextMessage),
            ),
            () => compactionAbortController.abort(),
          );
          if (shouldPromptAgent && handoffApplied && !capacityUpdate) {
            await runResume.requireDurableInputCheckpoint([
              ...agent!.state.messages,
              freshPromptMessage,
            ]);
          }
          run =
            shouldPromptAgent && !capacityUpdate
              ? agent!.prompt(freshPromptMessage)
              : agent!.continue();
          let discardedRetryUsage: AgentTurnUsage | undefined;
          let actionConfirmationRetryUsed = false;
          let providerRetryAttempt = 0;
          let emptyOutputAttempt = 0;
          const prepareRetry = async (messages: PiMessage[]): Promise<void> => {
            discardedRetryUsage = addAgentTurnUsage(
              discardedRetryUsage,
              getDiscardedRetryUsage(agent!.state.messages, messages),
            );
            agent!.state.messages = messages;
            await runResume.persistSafeBoundary(messages);
            signal?.throwIfAborted();
          };
          try {
            for (;;) {
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
                discardedRetryUsage,
                currentUsage,
              );
              turnUsage = addAgentTurnUsage(priorPhaseUsage, currentPhaseUsage);
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
                ...extractGenAiUsageAttributes(currentPhaseUsage),
              });
              const pendingAuthPause = getPendingAuthPause();
              if (pendingAuthPause) {
                runResume.captureResumeSnapshot(
                  runResume.getResumeSnapshot(currentAgentMessages()),
                );
                throw pendingAuthPause;
              }

              const confirmationRetry = actionConfirmationRetryUsed
                ? undefined
                : actionConfirmationRetryMessages(agent!.state.messages);
              if (confirmationRetry) {
                actionConfirmationRetryUsed = true;
                await prepareRetry(confirmationRetry);
                run = agent!.continue();
                continue;
              }

              const emptyOutputContinuation = nextEmptyOutputContinuation({
                attempt: emptyOutputAttempt,
                lastAssistant,
                messages: agent!.state.messages,
              });
              if (emptyOutputContinuation.kind === "retry") {
                emptyOutputAttempt += 1;
                await prepareRetry(emptyOutputContinuation.messages);
                logWarn("agent.turn.empty_output.retrying", {
                  "app.ai.empty_output.attempt": emptyOutputAttempt,
                });
                run = agent!.continue();
                continue;
              }
              if (emptyOutputContinuation.kind === "exhausted") {
                logWarn("agent.turn.empty_output.exhausted", {
                  "app.ai.empty_output.attempt": emptyOutputAttempt,
                });
              }

              const providerRetry = nextProviderRetry({
                attempt: providerRetryAttempt,
                failure: lastAssistant,
                messages: agent!.state.messages,
              });
              if (!providerRetry) {
                break;
              }

              providerRetryAttempt += 1;
              await prepareRetry(providerRetry.messages);
              logWarn("agent.turn.provider.retrying");
              await sleep(providerRetry.delayMs, signal);
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

    const providerError = findProviderError(error);
    logException(
      error,
      "assistant.reply.generation.failed",
      providerError ? getProviderErrorAttributes(providerError) : {},
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
    await closeTools?.();
  }
}
