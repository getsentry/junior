/** Input for one Run through Junior's agent. */
import type {
  Destination,
  ReplyAttribution,
  Source,
  SystemActor,
} from "@sentry/junior-plugin-api";
import type { Location } from "@/chat/conversations/location";
import type { LocationConfigurationService } from "@/chat/configuration/types";
import type { CredentialContext } from "@/chat/credentials/context";
import type { PiMessage } from "@/chat/pi/messages";
import type { Actor } from "@/chat/actor";
import type { SandboxRef } from "@/chat/sandbox/ref";
import type { SandboxEgressTracePropagationConfig } from "@/chat/sandbox/egress/tracing";
import type { SandboxEgressSignalTransport } from "@/chat/sandbox/egress/signals";
import type { OAuthAuthorization } from "@/chat/oauth-authorization";
import type { SlackConversationContext } from "@/chat/slack/conversation-context";
import type { ConversationPendingAuthState } from "@/chat/state/conversation";
import type { ConversationMessageProvenance } from "@/chat/conversations/provenance";
import type { AgentTurnSurface } from "@/chat/task-execution/checkpoint";
import type { ToolExecutionReport } from "@/chat/tool-support/tool-execution-report";
import type { SlackActionToken } from "@/chat/slack/action-token";
import type { TurnReasoningLevel } from "@/chat/reasoning-level";
import type {
  ImageGenerateToolDeps,
  ViewImageToolDeps,
  WebFetchToolDeps,
  WebSearchToolDeps,
} from "@/chat/tools/types";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { AttachmentStorage } from "@/chat/attachments/storage";

/** One attachment the model may see for the current instruction. */
export type AgentAttachment = {
  data?: Buffer;
  mediaType: string;
  filename?: string;
  promptText?: string;
};

/** Instruction author metadata used for prompt labels and provenance. */
export type AgentInstructionActor = {
  authorId?: string;
  authorName?: string;
  /**
   * Slack message ts for the instruction when known.
   * TODO(dcramer): Use a provider-neutral message id after prompt attributes no
   * longer require the Slack timestamp.
   */
  slackTs?: string;
};

/** One mid-turn steered user message drained from the durable mailbox. */
export type AgentSteeringMessage = {
  actor?: AgentInstructionActor;
  /** Provenance of this queued/steered message, carrying its original author. */
  provenance: ConversationMessageProvenance;
  omittedImageAttachmentCount?: number;
  text: string;
  timestampMs?: number;
  attachments?: AgentAttachment[];
};

/** Model-safe input for one asynchronously delegated child-agent task. */
export type SpawnAgentInput = {
  name?: string;
  reasoningLevel?: TurnReasoningLevel;
  task: string;
};

/** Handle returned after a child-agent task is durably scheduled. */
export type SpawnAgentResult = {
  invocationId: string;
};

/** Runtime-bound child-agent capability exposed to model-facing tool wiring. */
export type SpawnAgent = (
  input: SpawnAgentInput,
  options: { signal?: AbortSignal; toolCallId: string },
) => Promise<SpawnAgentResult>;

/** Current user instruction for one agent-run slice. */
export type AgentInstruction = {
  text: string;
  attachments?: readonly AgentAttachment[];
  inboundAttachmentCount?: number;
  omittedImageAttachmentCount?: number;
  /** Host-owned turn context shown to the model near the instruction. */
  context?: string;
  actor?: AgentInstructionActor;
  /**
   * When history is present, still include `context` in the prompt. Default is
   * to omit conversation context once durable history already carries it.
   */
  includeConversationContextWithHistory?: boolean;
};

/** Dispatch identity carried on plugin-authored runs. */
export type AgentDispatch = {
  actor?: SystemActor;
  id: string;
  metadata?: Record<string, string>;
  plugin?: string;
  replyAttribution?: ReplyAttribution;
};

/** Optional agent capabilities that a run slice can turn off. */
export const AGENT_RUN_FEATURES = [
  "handoff",
  "interactive-auth",
  "subagents",
] as const;

/** One optional agent capability controlled per run. */
export type AgentFeature = (typeof AGENT_RUN_FEATURES)[number];

/** Already-loaded resume state for this conversation. */
export type AgentRunState = {
  pendingAuth?: ConversationPendingAuthState;
  /** Persisted sandbox reuse state from prior slices of this conversation. */
  sandboxRef?: SandboxRef;
};

/**
 * Delivers completed tool-free assistant messages in model order.
 *
 * The runner must commit the preceding agent boundary before invoking this
 * port; the accepted reply transaction appends only this message.
 *
 * TODO(dcramer): Remove Conversation Message persistence from Delivery
 * implementations after the core Turn lifecycle stores each completed
 * assistant Message.
 */
export type Delivery = (message: AssistantMessage) => void | Promise<void>;

/** Resume the agent turn after a transient or ambiguous delivery failure. */
export class RetryableDeliveryError extends Error {
  constructor(cause: unknown) {
    super("Assistant delivery was transient or ambiguous", { cause });
    this.name = "RetryableDeliveryError";
  }
}

/** Durable-worker ports that commit or update resumable run state. */
export type AgentDurability = {
  /** Schedule delegated work with authority bound by the active parent run. */
  spawnAgent?: SpawnAgent;
  onInputCommitted?: () => void | Promise<void>;
  /** Return true when the durable worker should pause at the next Pi boundary. */
  shouldYield?: () => boolean;
  drainSteeringMessages?: (
    accept: (messages: AgentSteeringMessage[]) => Promise<void>,
  ) => Promise<AgentSteeringMessage[]>;
  recordPendingAuth?: (
    pendingAuth: ConversationPendingAuthState | undefined,
  ) => void | Promise<void>;
  onSandboxRefChanged?: (sandboxRef: SandboxRef) => void | Promise<void>;
};

/** Best-effort progress events. Failures here never affect the run. */
export type AgentEvent =
  | { type: "status"; text: string }
  | {
      type: "tool_started";
      toolCallId: string;
      toolName: string;
      params: Record<string, unknown>;
    }
  | { type: "tool_finished"; report: ToolExecutionReport };

/** Resolved environment and optional per-run tool test overrides. */
export type AgentEnvironment = {
  attachmentStorage?: AttachmentStorage;
  configuration?: Record<string, unknown>;
  locationConfiguration?: LocationConfigurationService;
  skillDirs?: string[];
  /** Per-slice override for app-owned sandbox egress trace propagation. */
  sandboxTracePropagation?: SandboxEgressTracePropagationConfig;
  /** Per-slice sandbox egress signal storage override. */
  sandboxEgressSignals?: SandboxEgressSignalTransport;
  toolOverrides?: {
    imageGenerate?: ImageGenerateToolDeps;
    viewImage?: ViewImageToolDeps;
    webFetch?: WebFetchToolDeps;
    webSearch?: WebSearchToolDeps;
  };
};

/**
 * One bounded attempt to advance a Turn.
 *
 * Build identity, instruction, history, delivery, and durability here. Bind
 * stable model/stream composition when creating the runner, not on each run.
 */
export type AgentRun = {
  /** Durable conversation advanced by this run. */
  conversationId: string;
  /** Stable turn advanced across this run and any continuation runs. */
  turnId: string;
  /** Optional bounded-run identifier used only for observability. */
  runId?: string;

  instruction: AgentInstruction;
  /** Durable Pi transcript for this conversation, excluding ephemeral turn context. */
  history?: readonly PiMessage[];

  /**
   * Who this run executes as. Prefer always setting this. Derive
   * `credentialContext` with `credentialContextForActor(actor, subject?)`
   * unless a caller already bound credentials.
   */
  actor?: Actor;
  /** Credential authority projected from actor (plus optional subject). */
  credentialContext?: CredentialContext;
  source: Source;
  /** Conversation Location available to this Run. */
  location?: Location;
  // TODO(dcramer): Remove AgentRun.destination after tool side effects use
  // feature-owned targets and place context comes from Location.
  destination: Destination;
  // TODO(dcramer): Remove AgentRun.publishExternally after Turn checkpoints
  // store publish and each provider uses it to supply Delivery before every Run.
  publishExternally?: boolean;
  surface?: AgentTurnSurface;
  dispatch?: AgentDispatch;

  /**
   * TODO(dcramer): Move ephemeral Slack credentials and conversation labels into
   * provider-owned tool/prompt context so the shared run edge stays neutral.
   */
  slackConversation?: SlackConversationContext;
  slackActionToken?: SlackActionToken;
  toolChannelId?: string;

  /** Surface-owned OAuth state and private delivery capabilities. */
  authorization?: OAuthAuthorization;

  /**
   * Optional agent capabilities disabled for this run slice.
   * `interactive-auth` blocks pausing to send an OAuth link; missing credentials
   * hard-fail instead. Default is enabled when omitted.
   * TODO(dcramer): Issues #881 and #883 track a path for child invocations to
   * force interactive auth when a delegated tool requires credentials the
   * parent can already request. Children currently disable it.
   */
  disabledFeatures?: readonly AgentFeature[];
  /** Absolute wall-clock deadline for this host request, in milliseconds. */
  deadlineAtMs?: number;
  /** Cancels provider work when the owning host request is abandoned. */
  signal?: AbortSignal;
  /** Explicit per-agent reasoning level. When set, adaptive routing is disabled. */
  reasoning?: TurnReasoningLevel;
  environment?: AgentEnvironment;

  state?: AgentRunState;
  /** Best-effort progress only. */
  onEvent?: (event: AgentEvent) => void | Promise<void>;
  delivery?: Delivery;
  durability?: AgentDurability;
};

/** Return whether one optional agent capability is disabled for this run. */
export function isAgentRunFeatureDisabled(
  disabledFeatures: readonly AgentFeature[] | undefined,
  feature: AgentFeature,
): boolean {
  return disabledFeatures?.includes(feature) ?? false;
}

/** Resolve the explicit actor, dispatch actor, or credential actor for this run. */
export function actorFromRun(
  run: Pick<AgentRun, "actor" | "dispatch" | "credentialContext">,
): Actor | undefined {
  if (run.dispatch?.actor) {
    return run.dispatch.actor;
  }
  if (run.actor) {
    return run.actor;
  }
  if (run.credentialContext && !("type" in run.credentialContext.actor)) {
    return run.credentialContext.actor;
  }
  return undefined;
}

/** Reject contradictory provider coordinates before the run touches state. */
export function assertRunConsistency(
  run: Pick<
    AgentRun,
    | "conversationId"
    | "source"
    | "location"
    | "destination"
    | "surface"
    | "actor"
    | "dispatch"
  >,
): void {
  const { destination, source } = run;
  switch (source.kind) {
    case "slack": {
      if (destination.platform !== "slack") {
        throw new TypeError(
          "Run source and destination platforms do not match",
        );
      }
      if (source.teamId !== destination.teamId) {
        throw new TypeError("Slack source and destination teams do not match");
      }
      break;
    }
    case "local": {
      if (destination.platform !== "local") {
        throw new TypeError(
          "Run source and destination platforms do not match",
        );
      }
      if (source.conversationId !== destination.conversationId) {
        throw new TypeError(
          "Source and destination conversation IDs do not match",
        );
      }
      if (
        run.surface !== "internal" &&
        destination.conversationId !== run.conversationId
      ) {
        throw new TypeError(
          "Source, destination, and run conversation IDs do not match",
        );
      }
      break;
    }
    case "web": {
      if (
        run.surface !== "internal" &&
        source.conversationId !== run.conversationId
      ) {
        throw new TypeError("Web source and run conversation IDs do not match");
      }
      switch (destination.platform) {
        case "local": {
          if (source.conversationId !== destination.conversationId) {
            throw new TypeError(
              "Source and destination conversation IDs do not match",
            );
          }
          if (
            run.surface !== "internal" &&
            destination.conversationId !== run.conversationId
          ) {
            throw new TypeError(
              "Source, destination, and run conversation IDs do not match",
            );
          }
          break;
        }
        case "slack":
          break;
      }
      break;
    }
    case "resource_event":
      break;
  }

  const actor = run.dispatch?.actor ?? run.actor;
  if (!actor || actor.platform === "system") {
    return;
  }
  if (actor.platform !== source.kind) {
    throw new TypeError(
      `Actor platform "${actor.platform}" does not match Source kind "${source.kind}"`,
    );
  }
  if (
    actor.platform === "slack" &&
    source.kind === "slack" &&
    actor.teamId !== source.teamId
  ) {
    throw new TypeError("Slack Actor team does not match Source team");
  }
}

/** Route tool side effects to the tool channel when one overrides the destination. */
export function toolInvocationDestination(
  run: Pick<AgentRun, "destination" | "toolChannelId">,
): Destination {
  if (run.destination.platform !== "slack" || !run.toolChannelId) {
    return run.destination;
  }
  return {
    platform: "slack",
    teamId: run.destination.teamId,
    channelId: run.toolChannelId,
  };
}

/** Infer the run surface when the caller did not state one. */
export function surfaceFromRun(
  run: Pick<AgentRun, "surface" | "source">,
): AgentTurnSurface {
  if (run.surface) {
    return run.surface;
  }
  if (run.source.kind === "slack") {
    return "slack";
  }
  if (run.source.kind === "web") {
    // Web/dashboard turns share the non-Slack api surface with agent-dispatch.
    return "api";
  }
  return "internal";
}
