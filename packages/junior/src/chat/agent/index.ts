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
  type AgentEvent,
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
  type SetSpanAttributes,
} from "@/chat/logging";
import { getConfigDefaults } from "@/chat/configuration/defaults";
import { SkillSandbox } from "@/chat/sandbox/skill-sandbox";
import {
  findSkillByName,
  parseSkillInvocation,
  type Skill,
} from "@/chat/skills";
import { McpToolManager } from "@/chat/mcp/tool-manager";
import {
  loadConnectedMcpProviders,
  recordAgentsInstructionsUpdated,
  recordToolExecutionStarted,
  recordMcpProviderConnected,
} from "@/chat/conversations/projection";
import {
  contextProvenance,
  instructionActors,
  instructionProvenanceFor,
  sameActorIdentity,
  type ConversationMessageProvenance,
} from "@/chat/conversations/provenance";
import { isUserActor, type Actor } from "@/chat/actor";
import {
  actorLogContext,
  credentialUserSubjectId,
} from "@/chat/credentials/context";
import {
  GEN_AI_PROVIDER_NAME,
  getGatewayApiKey,
  resolveGatewayModel,
} from "@/chat/pi/client";
import type { PiMessage } from "@/chat/pi/messages";
import { createRepositoryInstructionsContext } from "@/chat/agent/repository-context";
import {
  extractAssistantText,
  getUserMessageInstructionText,
  isAssistantMessage,
} from "@/chat/pi/transcript";
import { createTracedStreamFn } from "@/chat/pi/traced-stream";
import { createCacheWarmingRecorder } from "@/chat/cache-warming/warmup";
import { shouldEmitDevAgentTrace } from "@/chat/runtime/dev-agent-trace";
import {
  isTurnInputCommitLostError,
  TurnInputCommitLostError,
} from "@/chat/runtime/turn";
import type { AgentRunOutcome } from "@/chat/runtime/agent-run-outcome";
import { buildTurnResult } from "@/chat/services/turn-result";
import {
  isAnswerToolName,
  readTurnAnswer,
  remindMissingAnswer,
} from "@/chat/turn-answer";
import { decideReply } from "@/chat/services/assistant-reply";
import {
  findProviderError,
  getProviderErrorAttributes,
  isProviderRetryError,
} from "@/chat/services/provider-error";
import {
  nextProviderRetry,
  nextRefusalFallback,
} from "@/chat/services/provider-retry";
import { nextEmptyOutputContinuation } from "@/chat/services/empty-output-continuation";
import { getDiscardedRetryUsage } from "@/chat/agent/retry-usage";
import { projectTimedOutToolResult } from "@/chat/tool-support/timed-out-tool-result";
import { toPiReasoningLevel } from "@/chat/reasoning-level";
import {
  addAgentTurnUsage,
  agentTurnCostUsd,
  hasAgentTurnUsage,
  type AgentTurnUsage,
} from "@/chat/usage";
import {
  AuthPausePersistenceError,
  AuthorizationFlowDisabledError,
  AuthorizationPauseError,
} from "@/chat/services/auth-pause";
import {
  GATED_TURN_LIMIT_WRAP_UP_MESSAGE,
  TURN_LIMIT_WRAP_UP_MESSAGE,
  TurnBudgetExceededError,
  TurnToolCallLimitExceededError,
  createTurnLimitGate,
  isTurnExecutionLimitExceededError,
} from "@/chat/services/turn-limit";
import {
  resolveConversationPrivacy,
  runWithConversationPrivacy,
  toCanonicalOutputMessage,
  toGenAiMessagesTraceAttributes,
  type ConversationPrivacy,
} from "@/chat/conversation-privacy";
import { getConversationStore } from "@/chat/db";
import type { ConversationKind } from "@/chat/conversations/store";
import {
  isPersonInput,
  turnBehavior,
} from "@/chat/conversations/kind-behavior";
import {
  RetryableDeliveryError,
  assertRunConsistency,
  actorFromRun,
  surfaceFromRun,
  type AgentRun,
} from "@/chat/agent/types";
import { actionConfirmationRetryMessages } from "@/chat/agent/action-confirmation-retry";
import { readParentAgentTask } from "@/chat/input-tags";
import { loadTurnCheckpoint } from "@/chat/task-execution/checkpoint";
import { discoverRunSkills, loadRunSkill } from "@/chat/agent/skills";
import { missingAutomationSkillReason } from "@/chat/automations/skill";
import {
  assemblePrompt,
  buildPromptInput,
  buildSteeringPiMessage,
  loadPromptTurnContext,
} from "@/chat/agent/prompt";
import {
  createPromptHookContext,
  createRunSandbox,
  wireAgentTools,
} from "@/chat/agent/tools";
import { createResumeState, type ResumeState } from "@/chat/agent/resume";
import { sleep } from "@/chat/sleep";
import { getAgentContextCompactionTriggerTokens } from "@/chat/services/context-budget";
import { estimateRequestOverheadTokens } from "@/chat/services/token-estimate";
import { compactWithPreparedSummary } from "@/chat/services/context-compaction-swap";
import {
  lastRequestInputSize,
  requestBackgroundCompaction,
} from "@/chat/services/background-compaction";
import { createNextInputTracker } from "@/chat/services/context-compaction-telemetry";
import {
  buildAgentModelRequest,
  CONTEXT_COMPACTION_PROMPT_NAME,
  requestContextSummary,
} from "@/chat/agent/context-summary";
import { exclusiveToolName } from "@/chat/agent/exclusive-tools";
import {
  createToolBatchStats,
  recordToolBatch,
  toolBatchSpanAttributes,
} from "@/chat/agent/tool-batch";

const AGENT_ABORT_SETTLE_GRACE_MS = 5_000;
// Past a turn limit, a gated Turn gets this many failed answer calls before
// its run ends without an answer.
const MAX_FAILED_ANSWER_CALLS_PAST_LIMIT = 2;

/** Preserve delivery-error ownership across the agent generation boundary. */
class AssistantMessageDeliveryError extends Error {
  readonly originalError: unknown;

  constructor(originalError: unknown) {
    super("Assistant message delivery failed");
    this.originalError = originalError;
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
 * Prefer binding `streamFn` through `createAgentRunner`. The stream changes
 * model output only; prompt assembly, persistence, tools, delivery, and
 * completion still use the normal agent runtime.
 */
export async function executeAgentRun(
  run: AgentRun,
  streamFn?: StreamFn,
): Promise<AgentRunOutcome> {
  if (!run.destination) {
    throw new TypeError("Assistant reply generation requires a destination");
  }
  // A child reads visibility from its own Destination row, the same as a root.
  const conversation = await getConversationStore().get({
    conversationId: run.conversationId,
  });
  // Spawning a child writes its row first. Only a root can run before its
  // row exists.
  if (!conversation && run.parentConversationId) {
    throw new Error(
      `Child Conversation ${run.conversationId} has no Conversation row`,
    );
  }
  const visibility = conversation?.visibility;
  const conversationPrivacy = resolveConversationPrivacy({
    visibility,
  });
  const actor = actorFromRun(run);
  const runLogContext: LogContext = {
    conversationId: run.conversationId,
    platform:
      run.source.kind === "slack" ||
      run.source.kind === "web" ||
      run.source.kind === "local"
        ? run.source.kind
        : undefined,
    messageConversationId:
      run.source.kind === "slack"
        ? run.conversationId
        : run.source.kind === "web" || run.source.kind === "local"
          ? run.source.conversationId
          : run.conversationId,
    destinationName:
      run.location?.channelId ??
      (run.source.kind === "slack"
        ? run.source.channelId
        : run.source.kind === "web" || run.source.kind === "local"
          ? run.source.conversationId
          : run.conversationId),
    ...actorLogContext(actor, run.credentialContext),
    runId: run.runId,
    assistantUserName: botConfig.userName,
  };
  return withLogContext(runLogContext, () =>
    runWithConversationPrivacy(conversationPrivacy, () =>
      executeAgentRunInPrivacyContext(
        run,
        // TODO(dcramer): Remove the `root` case one release after #3060 step
        // 3. An Automation run in progress at deploy is stored as `root`.
        run.dispatch?.declaresResult
          ? "automation"
          : (conversation?.kind ?? "root"),
        conversationPrivacy,
        runLogContext,
        streamFn,
      ),
    ),
  );
}

async function executeAgentRunInPrivacyContext(
  run: AgentRun,
  conversationKind: ConversationKind,
  conversationPrivacy: ConversationPrivacy | undefined,
  runLogContext: LogContext,
  streamFn: StreamFn | undefined,
): Promise<AgentRunOutcome> {
  // Local views keep the existing loop body readable while the public edge is flat.
  const conversationId = run.conversationId;
  const turnId = run.turnId;
  const behavior = turnBehavior({
    kind: conversationKind,
    personInput: isPersonInput(run.source.kind),
  });
  const input = {
    actor: run.instruction.actor,
    messageText: run.instruction.text,
    userAttachments: run.instruction.attachments
      ? [...run.instruction.attachments]
      : undefined,
    inboundAttachmentCount: run.instruction.inboundAttachmentCount,
    omittedImageAttachmentCount: run.instruction.omittedImageAttachmentCount,
    piMessages: run.history ? [...run.history] : undefined,
    conversationContext: run.instruction.context,
  };
  const routing = {
    actor: run.actor,
    credentialContext: run.credentialContext,
    source: run.source,
    slackConversation: run.slackConversation,
    slackActionToken: run.slackActionToken,
    destination: run.destination,
    surface: run.surface,
    dispatch: run.dispatch,
    toolChannelId: run.toolChannelId,
  };
  const policy = {
    disabledFeatures: run.disabledFeatures,
    turnDeadlineAtMs: run.deadlineAtMs,
    signal: run.signal,
    reasoningLevel: run.reasoning,
    configuration: run.environment?.configuration,
    locationConfiguration: run.environment?.locationConfiguration,
    skillDirs: run.environment?.skillDirs,
    sandboxTracePropagation: run.environment?.sandboxTracePropagation,
    sandboxEgressSignals: run.environment?.sandboxEgressSignals,
    toolOverrides: run.environment?.toolOverrides,
  };
  const signal = policy.signal;
  const state = run.state ?? {};
  const observers = {
    onStatus: run.onEvent
      ? async (status: { text: string }) => {
          await run.onEvent?.({ type: "status", text: status.text });
        }
      : undefined,
    onToolInvocation: run.onEvent
      ? async (invocation: {
          params: Record<string, unknown>;
          toolCallId: string;
          toolName: string;
        }) => {
          await run.onEvent?.({
            type: "tool_started",
            params: invocation.params,
            toolCallId: invocation.toolCallId,
            toolName: invocation.toolName,
          });
        }
      : undefined,
    onToolResult: run.onEvent
      ? async (
          report: import("@/chat/tool-support/tool-execution-report").ToolExecutionReport,
        ) => {
          await run.onEvent?.({ type: "tool_finished", report });
        }
      : undefined,
  };
  const delivery = run.delivery;
  const authorization = run.authorization;
  const durability = run.durability ?? {};

  signal?.throwIfAborted();

  assertRunConsistency(run, conversationKind);

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
  // Pre-agent work that runs beside routing. The run waits for it to settle,
  // so a routing or wiring failure does not leave it running.
  let preAgentSetup: Promise<unknown> | undefined;
  let connectedMcpProviders = new Set<string>();
  let turnUsage: AgentTurnUsage | undefined;
  let priorPhaseUsage: AgentTurnUsage | undefined;
  // Kept outside the main try so timeout recovery can finish after delivery.
  let agent: Agent | undefined;
  let acceptedToolFreeAssistant = false;
  const generatedFiles: FileUpload[] = [];
  const toolCalls: string[] = [];
  let shouldTrace = false;
  let getSandboxRef: (() => typeof state.sandboxRef) | undefined;
  const reasoningLevel = policy.reasoningLevel ?? botConfig.reasoningLevel;
  // A refusal fallback replaces this for the rest of the run slice, so
  // compaction limits and input support follow the model that runs.
  let activeModelId = botConfig.modelId;
  const actor = actorFromRun(run);
  const surface = surfaceFromRun(run);
  const runSource = routing.source;
  const slackSource = runSource.kind === "slack" ? runSource : undefined;
  const userInput = input.messageText;
  const credentialUserId = run.credentialContext
    ? credentialUserSubjectId(run.credentialContext)
    : undefined;
  const recordConnectedMcpProvider = async (provider: string) => {
    if (connectedMcpProviders.has(provider)) {
      return;
    }
    // Only durable when we know who owns the connection. Restore filters by
    // this credential subject on later turns.
    if (credentialUserId) {
      await recordMcpProviderConnected({
        conversationId,
        provider,
        credentialSubjectId: credentialUserId,
      });
    }
    connectedMcpProviders.add(provider);
  };
  // A worker can stall past its Lease and come back after another worker
  // took the Conversation. Check the Lease right before each side effect.
  const requireConversationLease = async (
    action: "reply" | "save",
  ): Promise<void> => {
    if (durability.checkIn && !(await durability.checkIn())) {
      throw new TurnInputCommitLostError(
        `Conversation Lease lost before ${action} for conversation=${conversationId} turn=${turnId}`,
      );
    }
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
    shouldTrace = shouldEmitDevAgentTrace();
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
    // An Automation in skill mode names its skill in the dispatch, so its
    // text is not parsed for one.
    const dispatchSkill = run.dispatch?.skill;
    const skillInvocation = dispatchSkill
      ? { skillName: dispatchSkill }
      : parseSkillInvocation(userInput, availableSkills);
    const invokedSkill = skillInvocation
      ? findSkillByName(skillInvocation.skillName, availableSkills)
      : null;
    if (dispatchSkill && !invokedSkill) {
      throw new Error(missingAutomationSkillReason(dispatchSkill));
    }
    const activeSkills: Skill[] = [];
    const skillSandbox = new SkillSandbox(availableSkills, activeSkills);

    // ── Turn checkpoint (resume cursor) ──────────────────────────────
    const checkpoint = await loadTurnCheckpoint({ conversationId, turnId });
    const resumedFromSessionRecord = checkpoint.resumed;
    const currentSliceId = checkpoint.sliceId;
    const existingSessionRecord = checkpoint.record;
    // Mirror the committed provenance prefix the turn session record owns. A
    // fresh run may already include batched parked input committed before the
    // agent starts, then adds the current actor's turn-start instruction.
    // Steering appends to this array as it drains, so `run.actors` stays a
    // pure, live projection of committed instruction provenance.
    const turnStartProvenance =
      run.instruction.provenance ?? instructionProvenanceFor(actor);
    // Whose instructions this Run follows: its Actor, or nothing when an
    // agent wrote them. Only the requester's instructions are user intent.
    const requester = turnStartProvenance.actor;
    const isRequesterInstruction = (
      provenance: ConversationMessageProvenance | undefined,
    ): boolean =>
      provenance?.authority === "instruction" &&
      (provenance.actor
        ? sameActorIdentity(provenance.actor, requester)
        : !requester);
    const committedInstructionProvenance: ConversationMessageProvenance[] = [
      ...(existingSessionRecord?.piMessageProvenance ?? []),
      ...(existingSessionRecord?.actors ?? []).map(instructionProvenanceFor),
      ...(resumedFromSessionRecord ? [] : [turnStartProvenance]),
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
        if (!isRequesterInstruction(currentTurnProvenance[index])) {
          return [];
        }
        const text = getUserMessageInstructionText(message);
        return text ? [text] : [];
      }) ?? [];
    if (!resumedFromSessionRecord || guardianIntentParts.length === 0) {
      // Bare @mentions are normal Slack "continue this thread" nudges. After
      // bot-mention strip the instruction is empty; keep a non-blank marker so
      // action review can still run against thread evidence.
      // An input that is not an instruction, such as a nested result, is
      // evidence only.
      const text = isRequesterInstruction(turnStartProvenance)
        ? userInput.trim()
        : "";
      guardianIntentParts.push(
        readParentAgentTask(text) ?? (text || "[empty]"),
      );
    }
    const currentUserIntent = (): string => guardianIntentParts.join("\n\n");
    resume = createResumeState({
      channelName: routing.slackConversation?.name,
      ...(routing.credentialContext &&
      "subject" in routing.credentialContext &&
      routing.credentialContext.subject
        ? { credentialSubject: routing.credentialContext.subject }
        : undefined),
      destination: routing.destination,
      ...(routing.dispatch?.id
        ? { dispatchId: routing.dispatch.id }
        : undefined),
      durability,
      recordActiveMcpProviders,
      actor,
      runSource,
      conversationId,
      turnId,
      checkpoint,
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
    const persistedConfigurationValues = policy.locationConfiguration
      ? await policy.locationConfiguration.resolveValues()
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
    // Load only providers this credential subject connected. Shared thread
    // history is not authority and must not warm another person's MCP servers.
    connectedMcpProviders = new Set(
      credentialUserId
        ? await loadConnectedMcpProviders({
            conversationId,
            credentialSubjectId: credentialUserId,
          })
        : [],
    );

    // A new turn starts with no active skill. A resumed turn recovers only its
    // last successful loadSkill result, never skill state from older turns.
    const explicitSkill = await loadRunSkill({
      activeSkills,
      currentTurnMessages,
      invokedSkill,
      resumed: resumedFromSessionRecord,
      skillSandbox,
    });
    // ── Prompt input ─────────────────────────────────────────────────
    const { contextContentParts, userContentParts } = buildPromptInput({
      instruction: run.instruction,
    });
    const preAgentPromptMessages = (): PiMessage[] =>
      existingSessionRecord?.piMessages ?? [...(input.piMessages ?? [])];

    // ── Pre-agent setup ──────────────────────────────────────────────
    // Sandbox setup and prompt Turn context such as memory recall do not
    // read one another's results, so they run at the same time.
    const runSandbox = await createRunSandbox({
      availableSkills,
      configurationValues,
      currentActor: actor,
      currentActors: runActors,
      durability,
      onSandboxRefChanged: (sandboxRef) => {
        lastKnownSandboxRef = sandboxRef;
      },
      run,
      skillSandbox,
      spanContext,
      state,
    });
    closeTools = async () => runSandbox.agentSandbox.close();
    getSandboxRef = () => runSandbox.agentSandbox.sandboxRef();
    const repositoryInstructionsPromise = runSandbox.agentSandbox.sandboxRef()
      ? runSandbox.agentSandbox.captureRepositoryInstructions()
      : Promise.resolve(undefined);
    const promptTurnContextPromise = loadPromptTurnContext({
      context: createPromptHookContext({ actor, run, userInput }),
      currentActor: actor,
      existingSessionPiMessages: existingSessionRecord?.piMessages,
      existingTurnStartMessageIndex:
        existingSessionRecord?.turnStartMessageIndex,
      resumedFromSessionRecord,
      turnId,
      userContentParts,
    });
    preAgentSetup = Promise.allSettled([
      repositoryInstructionsPromise,
      promptTurnContextPromise,
    ]);

    // ── Mutable turn state ───────────────────────────────────────────
    let pendingPiHookError: Error | undefined;
    // A gated Turn's answer calls past a limit, and how many of them failed.
    const answerCallsPastLimit = new Set<string>();
    let failedAnswerCallsPastLimit = 0;
    // Tool calls that Junior ended the run with. Pi stops after a batch only
    // when every call in it is one of these.
    const terminatingToolCallIds = new Set<string>();
    // Model calls that a retry discarded. They still cost money.
    let discardedRetryUsage: AgentTurnUsage | undefined;
    const turnLimitGate = createTurnLimitGate(runResume.turnLimitWrappedUp);
    const currentAgentMessages = (): PiMessage[] =>
      agent ? [...agent.state.messages] : [];
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
    // Prompt assembly fills this; compaction updates close over it.
    let baseInstructions = "";

    setTags({
      ...runLogContext,
      modelId: activeModelId,
    });

    // ── Tool wiring ──────────────────────────────────────────────────
    const wiring = await wireAgentTools({
      abortAgent: () => agent?.abort(),
      activeSkills,
      behavior,
      currentActor: actor,
      currentAgentMessages,
      currentTurnMessages,
      currentUserIntent,
      availableSkills,
      configurationValues,
      connectedMcpProviders,
      conversationPrivacy,
      durability,
      authorization,
      generatedFiles,
      invokedSkill,
      onEvent: run.onEvent,
      onFatalToolError(error) {
        pendingPiHookError = error;
        agent?.abort();
      },
      preAgentPromptMessages,
      recordConnectedMcpProvider,
      resume: runResume,
      run,
      sandbox: runSandbox,
      skillSandbox,
      spanContext,
      state,
      supportsImageInput: () =>
        resolveGatewayModel(activeModelId).input.includes("image"),
      surface,
      toolCalls,
      userInput,
    });
    mcpToolManager = wiring.mcpToolManager;
    closeTools = wiring.close;
    const [initialRepositoryInstructions, promptTurnContext] =
      await Promise.all([
        repositoryInstructionsPromise,
        promptTurnContextPromise,
      ]);
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
    // ── Prompt context ───────────────────────────────────────────────
    const {
      baseInstructions: assembledBaseInstructions,
      contextContentParts: promptContextContentParts,
      inputMessages,
      inputMessagesAttribute,
      platform: promptPlatform,
      promptTimestamp: restoredPromptTimestamp,
      promptHistoryMessages,
      shouldPromptAgent,
      turnContexts,
      userContentParts: promptUserContentParts,
    } = await assemblePrompt({
      activeMcpCatalogs: wiring.activeMcpCatalogs,
      promptMode: behavior.promptMode,
      currentActor: actor,
      availableSkills,
      configurationValues,
      contextContentParts,
      conversationPrivacy,
      existingSessionPiMessages: existingSessionRecord?.piMessages,
      existingTurnStartMessageIndex:
        existingSessionRecord?.turnStartMessageIndex,
      explicitSkill,
      priorPiMessages,
      repositoryInstructions: initialRepositoryInstructions,
      resumedFromSessionRecord,
      run,
      spanContext,
      disabledTools: wiring.disabledTools,
      scriptTools: wiring.scriptTools,
      toolGuidance: wiring.toolGuidance,
      turnContext: promptTurnContext,
      userContentParts,
    });
    baseInstructions = assembledBaseInstructions;
    const repositoryInstructionsContext = createRepositoryInstructionsContext({
      capture: wiring.captureRepositoryInstructions,
      async commit(messages) {
        // Without explicit provenance, the commit attributes the message to
        // the Turn Actor, and a resumed Turn adds AGENTS.md again.
        await runResume.persistSafeBoundary(messages, [contextProvenance]);
      },
      hasSandbox: () => Boolean(wiring.getSandboxRef()),
      onTransition: recordAgentsTransition,
      promptContextContentParts,
      promptHistoryMessages,
      restoredMessages: existingSessionRecord?.piMessages,
      restoredProvenance: existingSessionRecord?.piMessageProvenance,
      setMessages(messages) {
        agent!.state.messages = messages;
      },
      shouldPromptAgent,
    });
    runResume.setTurnContexts(turnContexts);
    // The same stream as the agent loop, so the summary request reaches the
    // provider like an agent call. Only its span gets the prompt name.
    const summaryStreamFn = createTracedStreamFn({
      conversationPrivacy,
      promptName: CONTEXT_COMPACTION_PROMPT_NAME,
      ...(streamFn ? { base: streamFn } : undefined),
    });
    const nextInputAfterReplacement = createNextInputTracker();
    /**
     * Commit and adopt an active capacity replacement. True when it replaced
     * history.
     */
    const applyActiveContextCompaction = async (
      messages: PiMessage[],
      hookSignal?: AbortSignal,
      pendingMessages?: Array<{
        message: PiMessage;
        provenance: ConversationMessageProvenance;
      }>,
      clearSteeringQueueOnCommit = false,
      pairPendingRuntimeContext = false,
      mode: "blocking" | "active" = "active",
    ): Promise<boolean> => {
      // A ready background summary replaces history without a model call.
      const compaction = await compactWithPreparedSummary(
        {
          conversationId,
          modelId: activeModelId,
          onCompactionStart: () =>
            observers.onStatus?.({ text: "Compacting context" }),
          pendingMessages,
          mode,
          piMessages: messages,
          requestOverheadTokens: estimateRequestOverheadTokens(
            agent!.state.systemPrompt,
            agent!.state.tools,
            activeModelId,
          ),
          ...(pairPendingRuntimeContext && pendingMessages
            ? {
                runtimeContextMessages: [
                  ...messages,
                  ...pendingMessages.map((entry) => entry.message),
                ],
              }
            : undefined),
          signal: hookSignal,
          turnStartMessageIndex: runResume.turnStartMessageIndex,
        },
        async (summaryMessages, summarySignal) =>
          await requestContextSummary(
            await buildAgentModelRequest(
              agent!,
              summaryMessages,
              summarySignal,
            ),
            summaryStreamFn,
          ),
      );
      if (!compaction.compacted || !compaction.piMessages) {
        return false;
      }

      priorPhaseUsage = addAgentTurnUsage(
        priorPhaseUsage,
        usageSinceCurrentBoundary(messages),
      );
      const replacement = [...compaction.piMessages];
      // The whole replacement belongs to this Turn. Set the Turn start first,
      // so the checkpoint does not keep an index into the old history.
      const previousTurnStartMessageIndex = runResume.turnStartMessageIndex;
      runResume.setTurnStartMessageIndex(0);
      try {
        await runResume.requireDurableInputCheckpoint(replacement);
      } catch (error) {
        runResume.setTurnStartMessageIndex(previousTurnStartMessageIndex);
        throw error;
      }
      agent!.state.messages = replacement;
      nextInputAfterReplacement.replaced(
        mode,
        getAgentContextCompactionTriggerTokens(activeModelId),
      );
      runResume.setBeforeMessageCount(replacement.length);
      runResume.adoptCommittedBoundary(replacement);
      if (clearSteeringQueueOnCommit && pendingMessages?.length) {
        agent!.clearSteeringQueue();
      }
      return true;
    };
    /**
     * Request a background summary when the model call that just ended was at
     * or above the mark. It runs after each model call, so a long Turn gets a
     * summary before it reaches the compaction threshold.
     */
    const requestBackgroundCompactionAfterModelCall = async (): Promise<void> =>
      await requestBackgroundCompaction({
        agent: agent!,
        conversationId,
        conversationPrivacy,
        modelId: activeModelId,
        queue: run.environment?.backgroundCompactionQueue,
      });
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
        await requireConversationLease("reply");
        await delivery(message);
        acceptedToolFreeAssistant = true;
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
            const text = message.text.trim();
            if (isRequesterInstruction(message.provenance) && text) {
              guardianIntentParts.push(readParentAgentTask(text) ?? text);
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

    // Pi converts listener exceptions into error turns
    // instead of rejecting. Preserve Junior's yield so runAgentStep can
    // restore it after the Pi run settles without leaking Pi mechanics into
    // the resume API.
    // A Task inherits the person's actor, but only its parent agent sends it
    // Turns. Keep its gaps out of the histograms of people.
    const cacheWarming = createCacheWarmingRecorder(
      conversationId,
      isUserActor(actor) && conversationKind !== "task",
      { platform: promptPlatform, mode: behavior.promptMode },
    );
    // Batch counts go on the `gen_ai.invoke_agent` span, because production
    // drops info logs.
    const toolBatchStats = createToolBatchStats();
    let setAgentSpanAttributes: SetSpanAttributes | undefined;
    // The `turn_end` listener changed `agent.state.messages`, which Pi does
    // not read. `prepareNextTurn` gives them to the next model call.
    let messagesChanged = false;
    // The `turn_end` listener compacted after a batch that ended the run, and
    // took the pending steering out of Pi's queue. Pi stops without a model
    // call for that steering, so the run loop continues it.
    let steeringAwaitsModelCall = false;
    /**
     * Do Junior's work after a model call and its tool batch, before Pi polls
     * steering. Pi awaits this listener after every model call. Pi turns its
     * errors into error turns, so the caller keeps them for the step.
     */
    const finishModelStep = async (
      event: Extract<AgentEvent, { type: "turn_end" }>,
      runSignal: AbortSignal | undefined,
    ): Promise<void> => {
      if (event.toolResults.length > 0) {
        cacheWarming.toolsReturned();
        await requireConversationLease("save");
        await runResume.persistSafeBoundary([...agent!.state.messages]);
      }
      // Pi ends the run after a failed or aborted model call, and the turn
      // that reports a run failure is the last event. After an abort, such
      // as an auth pause, no model call follows. Sandbox work here fails on
      // the aborted signal and hides why the run stopped. Steering stays
      // queued.
      if (
        runSignal?.aborted ||
        (isAssistantMessage(event.message) &&
          (event.message.stopReason === "error" ||
            event.message.stopReason === "aborted"))
      ) {
        return;
      }
      // A stop of this Conversation ends the Turn at the next step, also
      // when no stop request reached this worker.
      await durability.checkStop?.();
      signal?.throwIfAborted();
      // The span shows the wait between `gen_ai.chat` spans.
      const boundary = await withSpan(
        "agent.step.prepare",
        "agent.step.prepare",
        {},
        async () => {
          // Pi appends steering after its context, so add AGENTS.md context
          // first to commit the same message order.
          const contextUpdate = await repositoryInstructionsContext.applyUpdate(
            {
              messages: currentAgentMessages(),
              systemPrompt: agent!.state.systemPrompt,
              tools: agent!.state.tools,
            },
          );
          const pendingMessages = await drainSteeringMessages();
          // Pi stops after a batch only when every call in it is one of
          // `terminatingToolCallIds`, and no steering is pending.
          const batchEndsRun = event.toolResults.every((result) =>
            terminatingToolCallIds.has(result.toolCallId),
          );
          const runEnded = pendingMessages.length === 0 && batchEndsRun;
          // A background request does not change history, so it runs also
          // after the last model call.
          if (runEnded) {
            await requestBackgroundCompactionAfterModelCall();
          }
          return { batchEndsRun, contextUpdate, pendingMessages, runEnded };
        },
      );
      messagesChanged = Boolean(boundary.contextUpdate);
      // A yield is normal control flow, so it stays out of the span. It
      // comes before active compaction, so a resumed slice compacts at its
      // start.
      const yieldError = runResume.prepareYieldIfDue(currentAgentMessages());
      if (yieldError) {
        throw yieldError;
      }
      // After the final response or a batch that ended the run, such as a
      // `noReply` call, compaction would drop the answer and start a retry.
      if (boundary.runEnded) {
        return;
      }
      // Pi polls steering after this listener. The replacement ends with the
      // pending steering, so compacting here takes it out of Pi's queue.
      const compacted = await applyActiveContextCompaction(
        currentAgentMessages(),
        runSignal,
        boundary.pendingMessages,
        true,
      );
      if (compacted) {
        messagesChanged = true;
        steeringAwaitsModelCall = boundary.batchEndsRun;
        return;
      }
      // After a replacement, the usage of the last model call counts the old
      // history. The next model call reports the new size.
      await requestBackgroundCompactionAfterModelCall();
    };
    agent = new Agent({
      // Resolve on every provider call so runtime OIDC tokens stay fresh.
      getApiKey: getGatewayApiKey,
      // One AI Gateway session per Conversation, not a prompt fingerprint.
      sessionId: conversationId,
      streamFn: createTracedStreamFn({
        conversationPrivacy,
        base: cacheWarming.wrap(streamFn),
        endAttributes: (message) =>
          nextInputAfterReplacement.attributes(lastRequestInputSize([message])),
      }),
      steeringMode: "all",
      beforeToolCall: async ({ assistantMessage, context, toolCall }) => {
        const toolCalls = assistantMessage.content.filter(
          (part) => part.type === "toolCall",
        );
        if (toolCalls.length > 1 && toolCall.id === toolCalls[0]!.id) {
          recordToolBatch(toolBatchStats, toolCalls, context.tools ?? []);
          setAgentSpanAttributes?.(toolBatchSpanAttributes(toolBatchStats));
        }
        const exclusiveTool = exclusiveToolName(toolCalls);
        if (exclusiveTool && toolCalls.length !== 1) {
          return {
            block: true,
            reason: `${exclusiveTool} must be the only tool call in its assistant message; reissue it alone`,
          };
        }
        // Past a limit, the first step is blocked so the model replies with
        // its progress. A later tool call ends the turn: Pi turns exceptions
        // into tool errors, so block + terminate and rethrow after the step.
        const toolCallCount = runResume.countToolCall();
        const turnCostUsd =
          agentTurnCostUsd(
            addAgentTurnUsage(
              runResume.priorSliceUsage,
              priorPhaseUsage,
              discardedRetryUsage,
              usageSinceCurrentBoundary(currentAgentMessages()),
            ),
          ) ?? 0;
        const overBudget = turnCostUsd >= botConfig.maxTurnCostUsd;
        const overLimit =
          overBudget || toolCallCount > botConfig.maxToolCallsPerTurn;
        // A gated Turn must answer, so its answer tool runs past a limit.
        if (behavior.gated && isAnswerToolName(toolCall.name)) {
          if (overLimit || runResume.turnLimitWrappedUp) {
            answerCallsPastLimit.add(toolCall.id);
          }
          return undefined;
        }
        const decision = turnLimitGate({ assistantMessage, overLimit });
        if (decision === "allow") {
          return undefined;
        }
        if (decision === "wrap_up") {
          runResume.markTurnLimitWrappedUp();
          logWarn("agent.turn.limit.wrap_up", {
            "app.ai.cost.total_usd": turnCostUsd,
            "app.ai.tool_call_count": toolCallCount,
          });
          return {
            block: true,
            reason: behavior.gated
              ? GATED_TURN_LIMIT_WRAP_UP_MESSAGE
              : TURN_LIMIT_WRAP_UP_MESSAGE,
          };
        }
        // The tool-call total only grows, so a stop under it came from spend.
        const limitError =
          toolCallCount > botConfig.maxToolCallsPerTurn && !overBudget
            ? new TurnToolCallLimitExceededError(botConfig.maxToolCallsPerTurn)
            : new TurnBudgetExceededError(botConfig.maxTurnCostUsd);
        pendingPiHookError ??= limitError;
        terminatingToolCallIds.add(toolCall.id);
        return {
          block: true,
          reason: limitError.message,
          terminate: true,
        };
      },
      afterToolCall: async ({ isError, result, toolCall }, signal) => {
        // Host continuity is session-owned (`resumeReason: "timeout"` + auto
        // continue). Only rewrite tool attempts that themselves aborted; a
        // finished sibling must keep its real result. Project those preempted
        // attempts onto the normal `timed_out` field — not cancelled jargon.
        const timedOutResult =
          runResume.timedOut && signal?.aborted
            ? projectTimedOutToolResult(result)
            : undefined;
        const sourceResult = timedOutResult ?? result;
        const projectedResult = wiring.projectActionReviewResult(
          toolCall.id,
          sourceResult,
        );
        const override =
          timedOutResult || projectedResult !== result
            ? projectedResult
            : undefined;
        // A reply, blocked report, or no-reply is the last step of the run.
        if (isAnswerToolName(toolCall.name) && !isError && !override) {
          cacheWarming.answerToolEnded(toolCall.name);
          terminatingToolCallIds.add(toolCall.id);
          return { terminate: true };
        }
        // Past a limit, the second failed answer call ends the run without
        // an answer.
        if (
          isError &&
          answerCallsPastLimit.has(toolCall.id) &&
          ++failedAnswerCallsPastLimit >= MAX_FAILED_ANSWER_CALLS_PAST_LIMIT
        ) {
          terminatingToolCallIds.add(toolCall.id);
          return { ...override, terminate: true };
        }
        return override;
      },
      // Pi runs this hook only before another model call. Only its return
      // value changes the context of that call.
      prepareNextTurnWithContext: async (nextTurn) => {
        if (!messagesChanged) {
          return undefined;
        }
        messagesChanged = false;
        return {
          context: { ...nextTurn.context, messages: currentAgentMessages() },
        };
      },
      initialState: {
        systemPrompt: baseInstructions,
        model: resolveGatewayModel(activeModelId),
        thinkingLevel: toPiReasoningLevel(reasoningLevel),
        tools: wiring.agentTools,
      },
    });

    const unsubscribe = agent.subscribe((event, runSignal) => {
      if (event.type === "tool_execution_start") {
        return recordParentToolExecutionStart(event);
      }
      if (event.type === "turn_end") {
        return finishModelStep(event, runSignal).catch((error: unknown) => {
          // Pi turns a listener error into a failed model message, so keep
          // the error for the step to rethrow.
          pendingPiHookError ??=
            error instanceof Error ? error : new Error(String(error));
          throw error;
        });
      }
      if (event.type === "message_end" && isAssistantMessage(event.message)) {
        const message = event.message;
        const delivery =
          message.stopReason === "error" || message.stopReason === "aborted"
            ? undefined
            : deliverAssistantMessage(message);
        // Record after delivery, so the reply is not late. Record also when
        // delivery fails: the model call wrote the cache and ended the idle
        // period either way.
        return Promise.resolve(delivery).then(
          () => cacheWarming.record(message),
          async (error: unknown) => {
            await cacheWarming.record(message);
            throw error;
          },
        );
      }
      return undefined;
    });

    let newMessages: PiMessage[] = [];
    // A resumed slice can prompt again, which moves the live Turn start, so
    // read the answer from the saved start. A slice from before saved Turn
    // starts reads only its own messages.
    const turnStartIndex = () =>
      existingSessionRecord?.turnStartMessageIndex ??
      runResume.turnStartMessageIndex ??
      runResume.beforeMessageCount;
    const turnMessages = () => agent!.state.messages.slice(turnStartIndex());
    try {
      if (resumedFromSessionRecord) {
        agent.state.messages = shouldPromptAgent
          ? promptHistoryMessages
          : existingSessionRecord!.piMessages;
        runResume.setTurnStartMessageIndex(
          existingSessionRecord!.turnStartMessageIndex,
        );
        // Timeout/retry parking needs a durable baseline even when the first
        // mid-run checkpoint fails. Without this, an empty safe boundary can
        // re-park the same stuck slice forever.
        runResume.adoptCommittedBoundary([...agent.state.messages]);
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
        async (setInvokeAgentSpanAttributes) => {
          setAgentSpanAttributes = setInvokeAgentSpanAttributes;
          // An answer is final. A resumed slice of a gated Turn returns it
          // without calling the model.
          if (behavior.gated && readTurnAnswer(turnMessages())) {
            return undefined;
          }
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
              await runResume.requireDurableInputCheckpoint(
                [
                  ...agent!.state.messages,
                  ...(contextMessage ? [contextMessage] : []),
                  freshPromptMessage,
                ],
                [turnStartProvenance],
              );
            if (promptPersisted) {
              await runResume.commitInput();
            }
          }
          if (contextMessage) {
            agent!.state.messages = [...agent!.state.messages, contextMessage];
          }
          if (!shouldPromptAgent) {
            await repositoryInstructionsContext.applyUpdate({
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
                  "gen_ai.request.reasoning.level": reasoningLevel,
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
              if (pendingPiHookError) {
                const hookError = pendingPiHookError;
                pendingPiHookError = undefined;
                throw hookError;
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

          let run: Promise<unknown>;
          const compactionAbortController = new AbortController();
          const compacted = await runAgentStep(
            applyActiveContextCompaction(
              [...agent!.state.messages],
              compactionAbortController.signal,
              shouldPromptAgent
                ? [
                    {
                      message: freshPromptMessage,
                      provenance: turnStartProvenance,
                    },
                  ]
                : undefined,
              false,
              Boolean(contextMessage),
              // The person waits on this one, before the first model request.
              "blocking",
            ),
            () => compactionAbortController.abort(),
          );
          run =
            shouldPromptAgent && !compacted
              ? agent!.prompt(freshPromptMessage)
              : agent!.continue();
          discardedRetryUsage = undefined;
          let actionConfirmationRetryUsed = false;
          let answerReminderUsed = !behavior.gated;
          let providerRetryAttempt = 0;
          let refusalFallbackUsed = false;
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
                  : undefined),
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
                  : undefined),
                ...extractGenAiUsageAttributes(currentPhaseUsage),
              });
              const pendingAuthPause = getPendingAuthPause();
              if (pendingAuthPause) {
                runResume.captureResumeSnapshot(
                  runResume.getResumeSnapshot(currentAgentMessages()),
                );
                throw pendingAuthPause;
              }

              if (steeringAwaitsModelCall) {
                steeringAwaitsModelCall = false;
                messagesChanged = false;
                run = agent!.continue();
                continue;
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

              const answerReminder =
                answerReminderUsed ||
                failedAnswerCallsPastLimit >= MAX_FAILED_ANSWER_CALLS_PAST_LIMIT
                  ? undefined
                  : remindMissingAnswer(
                      agent!.state.messages,
                      turnStartIndex(),
                    );
              if (answerReminder) {
                answerReminderUsed = true;
                agent!.state.messages = answerReminder;
                await runResume.persistSafeBoundary(answerReminder);
                logWarn("agent.turn.answer.reminded", {});
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
                const refusalFallback = refusalFallbackUsed
                  ? undefined
                  : nextRefusalFallback({
                      failure: lastAssistant,
                      fallbackModelId: botConfig.refusalFallbackModelId,
                      messages: agent!.state.messages,
                    });
                if (!refusalFallback) {
                  break;
                }
                // Only the rest of this run slice uses the fallback model. A
                // later slice or Turn starts again on the main model.
                refusalFallbackUsed = true;
                await prepareRetry(refusalFallback.messages);
                // `gen_ai.request.model` is the main model that refused.
                // `app.ai.refusal_fallback.model` is the model of the next
                // `gen_ai.chat` span.
                logWarn("agent.turn.refusal_fallback", {
                  "gen_ai.request.model": activeModelId,
                  "app.ai.refusal_fallback.model": refusalFallback.modelId,
                });
                activeModelId = refusalFallback.modelId;
                agent!.state.model = resolveGatewayModel(activeModelId);
                run = agent!.continue();
                continue;
              }

              providerRetryAttempt += 1;
              await prepareRetry(providerRetry.messages);
              logWarn("agent.turn.provider.retrying", {
                ...getProviderErrorAttributes(providerRetry.providerError),
                "app.ai.provider_error.retry_attempt": providerRetryAttempt,
              });
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
          return undefined;
        },
        {
          "gen_ai.operation.name": "invoke_agent",
          "gen_ai.agent.model": activeModelId,
          "gen_ai.agent.reasoning.level": reasoningLevel,
          "gen_ai.output.type": "text",
          ...(conversationPrivacy
            ? { "app.conversation.privacy": conversationPrivacy }
            : undefined),
          "app.ai.session.conversation_id": conversationId,
          "app.ai.turn.session_id": turnId,
          ...(currentSliceId
            ? { "app.ai.turn.slice_id": currentSliceId }
            : undefined),
          ...toGenAiMessagesTraceAttributes("gen_ai.input", inputMessages),
          ...(inputMessagesAttribute
            ? { "gen_ai.input.messages": inputMessagesAttribute }
            : undefined),
        },
      );
      if (authPauseOutcome) {
        return authPauseOutcome;
      }
    } finally {
      unsubscribe();
      await cacheWarming.stop();
    }

    // The caller saves the completed Turn after this returns.
    await requireConversationLease("save");
    await recordActiveMcpProviders();
    // Generation completing is not durable completion: the session record
    // stays at its latest running safe boundary here. The destination owns the
    // completed session record after assistant output handling settles, so a
    // crash before that commit remains recoverable as a stranded run.

    // ── Build turn result ────────────────────────────────────────────
    const result = buildTurnResult({
      newMessages,
      userInput,
      toolCalls,
      sandboxRef: wiring.getSandboxRef(),
      piMessages: [...agent.state.messages],
      durationMs: Date.now() - replyStartedAtMs,
      generatedFileCount: generatedFiles.length,
      shouldTrace,
      usage: turnUsage,
      reasoningLevel,
      assistantUserName: botConfig.userName,
      modelId: activeModelId,
      ...(behavior.gated
        ? {
            answer: readTurnAnswer(turnMessages()) ?? "missing",
            // The dispatch Turn of an Automation run fails without an
            // answer, so the run history shows it.
            missingAnswerError: run.dispatch
              ? "Automation run ended without an answer."
              : behavior.missingAnswerError,
          }
        : undefined),
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
    // Another worker holds the Lease. Do not complete or park the Turn.
    if (isTurnInputCommitLostError(runError)) {
      throw runError;
    }
    if (
      runError instanceof AuthPausePersistenceError ||
      isTurnExecutionLimitExceededError(runError)
    ) {
      throw runError;
    }
    if (resume && runError instanceof AuthorizationPauseError) {
      // Eager provider restoration can request auth before the agent span
      // exists; use the same durable parking operation as the in-span path.
      return await resume.parkForAuth(runError, turnUsage);
    }
    // One writer for agent history: once destination accepted a tool-free
    // reply, hard timeout must finish the turn. Do not park a trimmed boundary
    // that fights the accepted assistant already written by delivery.
    // Soft yield after a pure assistant tail is already a no-op (not
    // continuable). Soft yield after delivery + steering still parks so the
    // steered work can run on the next slice.
    if (resume?.timedOut && acceptedToolFreeAssistant && agent) {
      // The caller saves the completed Turn after this returns.
      await requireConversationLease("save");
      await recordActiveMcpProviders();
      const piMessages = [...agent.state.messages];
      return {
        status: "completed",
        result: buildTurnResult({
          newMessages: piMessages.slice(resume.beforeMessageCount),
          userInput,
          toolCalls,
          sandboxRef: getSandboxRef?.() ?? lastKnownSandboxRef,
          piMessages,
          durationMs: Date.now() - replyStartedAtMs,
          generatedFileCount: generatedFiles.length,
          shouldTrace,
          usage: turnUsage,
          reasoningLevel,
          assistantUserName: botConfig.userName,
          modelId: activeModelId,
        }),
      };
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
    // The caller aborted the run, such as when a person stops the Turn. The
    // caller owns that outcome; it is not a reply failure to report.
    if (!signal?.aborted || error !== signal.reason) {
      const providerError = findProviderError(error);
      logException(
        error,
        "assistant.reply.generation.failed",
        providerError ? getProviderErrorAttributes(providerError) : {},
      );
    }

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
          reasoningLevel,
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
    await preAgentSetup;
    await closeTools?.();
  }
}
