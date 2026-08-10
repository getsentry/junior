/**
 * Agent run request contract.
 *
 * Groups the per-slice run request by the runtime role each field serves and
 * owns interpretation of the routing group: actor derivation, surface
 * inference, destination consistency checks, and session identifiers. Run
 * phases consume these groups directly; callers build them at runtime
 * boundaries.
 */
import type {
  Destination,
  ReplyAttribution,
  Source,
  SystemActor,
} from "@sentry/junior-plugin-api";
import type { LocationConfigurationService } from "@/chat/configuration/types";
import type { ConversationPrivacy } from "@/chat/conversation-privacy";
import type { CredentialContext } from "@/chat/credentials/context";
import type { PiMessage } from "@/chat/pi/messages";
import type { Actor } from "@/chat/actor";
import type { SandboxRef } from "@/chat/sandbox/ref";
import type { SandboxEgressTracePropagationConfig } from "@/chat/sandbox/egress/tracing";
import type { SandboxEgressSignalTransport } from "@/chat/sandbox/egress/signals";
import type { OAuthAuthorization } from "@/chat/oauth-authorization";
import type { AssistantStatusSpec } from "@/chat/slack/assistant-thread/status";
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

export interface AgentRunAttachment {
  data?: Buffer;
  mediaType: string;
  filename?: string;
  promptText?: string;
}

export interface AgentRunInstructionActor {
  authorId?: string;
  authorName?: string;
  slackTs?: string;
}

export interface AgentRunSteeringMessage {
  actor?: AgentRunInstructionActor;
  /** Provenance of this queued/steered message, carrying its original author. */
  provenance: ConversationMessageProvenance;
  omittedImageAttachmentCount?: number;
  text: string;
  timestampMs?: number;
  userAttachments?: AgentRunAttachment[];
}

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

/** Carries the user-visible content and prior transcript for one agent-run slice. */
export interface AgentRunInput {
  actor?: AgentRunInstructionActor;
  includeConversationContextWithPiMessages?: boolean;
  messageText: string;
  userAttachments?: AgentRunAttachment[];
  inboundAttachmentCount?: number;
  omittedImageAttachmentCount?: number;
  /** Durable Pi transcript for this conversation, excluding ephemeral turn context. */
  piMessages?: PiMessage[];
  conversationContext?: string;
}

/**
 * Identity and addressing for one run.
 *
 * Set `actor` first (who runs). Derive `credentialContext` with
 * `credentialContextForActor(actor, subject?)` unless a caller already bound
 * credentials (dispatch with delegated subject). They name the same principal
 * except when a system actor carries `credentialContext.subject` for delegated
 * user tokens.
 */
export interface AgentRunRouting {
  /** Who this run executes as. Prefer always setting this. */
  actor?: Actor;
  /** Credential authority projected from actor (plus optional subject). */
  credentialContext?: CredentialContext;
  source: Source;
  slackConversation?: SlackConversationContext;
  /**
   * TODO: Move ephemeral Slack credentials into provider-owned turn context so
   * the Slack tool registry can consume them without extending core routing.
   */
  slackActionToken?: SlackActionToken;
  destination: Destination;
  /** When true, also publish assistant output to the conversation destination. */
  publishExternally?: boolean;
  /** Confirmed visibility of the destination where this run is delivered. */
  destinationVisibility?: ConversationPrivacy;
  surface?: AgentTurnSurface;
  dispatch?: {
    actor?: SystemActor;
    id: string;
    metadata?: Record<string, string>;
    plugin?: string;
    replyAttribution?: ReplyAttribution;
  };
  toolChannelId?: string;
}

/** Optional agent capabilities that a run slice can turn off. */
export const AGENT_RUN_FEATURES = [
  "handoff",
  "interactive-auth",
  "subagents",
] as const;

/** One optional agent capability controlled by run policy. */
export type AgentRunFeature = (typeof AGENT_RUN_FEATURES)[number];

/** Return whether one optional agent capability is disabled for this run. */
export function isAgentRunFeatureDisabled(
  policy: Pick<AgentRunPolicy, "disabledFeatures"> | undefined,
  feature: AgentRunFeature,
): boolean {
  return policy?.disabledFeatures?.includes(feature) ?? false;
}

/** Carries execution limits and dependency overrides for one run slice. */
export interface AgentRunPolicy {
  /**
   * Optional agent capabilities disabled for this run slice.
   * `interactive-auth` blocks pausing to send an OAuth link; missing credentials
   * hard-fail instead. Default is enabled when omitted.
   * TODO(#881, #883): child invocations currently disable interactive-auth, but
   * may later need a path to force the auth flow when a delegated tool requires
   * credentials the parent can already request.
   */
  disabledFeatures?: readonly AgentRunFeature[];
  /** Absolute wall-clock deadline for this host request, in milliseconds. */
  turnDeadlineAtMs?: number;
  /** Cancels provider work when the owning host request is abandoned. */
  signal?: AbortSignal;
  /** Explicit per-agent reasoning level. When set, adaptive routing is disabled. */
  reasoningLevel?: TurnReasoningLevel;
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
}

/** Carries durable state snapshots already loaded by the caller. */
export interface AgentRunState {
  pendingAuth?: ConversationPendingAuthState;
  /** Persisted sandbox reuse state from prior slices of this conversation. */
  sandboxRef?: SandboxRef;
}

/**
 * Carries notification-only callbacks for streaming UI and status surfaces;
 * their failures never affect the run.
 */
export interface AgentRunObservers {
  onToolInvocation?: (invocation: {
    params: Record<string, unknown>;
    toolCallId: string;
    toolName: string;
  }) => void | Promise<void>;
  onToolResult?: (result: ToolExecutionReport) => void | Promise<void>;
  onStatus?: (status: AssistantStatusSpec) => void | Promise<void>;
}

/**
 * Delivers completed tool-free assistant messages in model order.
 *
 * The runner must commit the preceding agent boundary before invoking this
 * port; the accepted reply transaction appends only this message.
 */
export type AgentRunDelivery = (
  message: AssistantMessage,
) => void | Promise<void>;

/** Resume the agent turn after a transient or ambiguous delivery failure. */
export class RetryableDeliveryError extends Error {
  constructor(cause: unknown) {
    super("Assistant delivery was transient or ambiguous", { cause });
    this.name = "RetryableDeliveryError";
  }
}

/** Carries durable-worker ports that commit or update resumable run state. */
export interface AgentRunDurability {
  /** Schedule delegated work with authority bound by the active parent run. */
  spawnAgent?: SpawnAgent;
  onInputCommitted?: () => void | Promise<void>;
  /** Return true when the durable worker should pause at the next Pi boundary. */
  shouldYield?: () => boolean;
  drainSteeringMessages?: (
    accept: (messages: AgentRunSteeringMessage[]) => Promise<void>,
  ) => Promise<AgentRunSteeringMessage[]>;
  recordPendingAuth?: (
    pendingAuth: ConversationPendingAuthState | undefined,
  ) => void | Promise<void>;
  onSandboxRefChanged?: (sandboxRef: SandboxRef) => void | Promise<void>;
}

/** Groups the per-slice run request by the runtime role each field serves. */
export interface AgentRunRequest {
  /** Durable conversation advanced by this run. */
  conversationId: string;
  /** Stable turn advanced across this run and any continuation runs. */
  turnId: string;
  /** Optional bounded-run identifier used only for observability. */
  runId?: string;
  input: AgentRunInput;
  routing: AgentRunRouting;
  /** Surface-owned OAuth state and private delivery capabilities. */
  authorization?: OAuthAuthorization;
  policy?: AgentRunPolicy;
  state?: AgentRunState;
  observers?: AgentRunObservers;
  delivery?: AgentRunDelivery;
  durability?: AgentRunDurability;
}

/** Resolve the explicit actor or the system credential actor for this run. */
export function actorFromRouting(routing: AgentRunRouting): Actor | undefined {
  if (routing.dispatch?.actor) {
    return routing.dispatch.actor;
  }
  if (routing.actor) {
    return routing.actor;
  }
  if (
    routing.credentialContext &&
    !("type" in routing.credentialContext.actor)
  ) {
    return routing.credentialContext.actor;
  }
  return undefined;
}

/** Reject contradictory provider coordinates before the run touches state. */
export function assertRunRoutingConsistency(
  request: Pick<AgentRunRequest, "conversationId" | "routing">,
): void {
  const { destination, source } = request.routing;
  // API/dashboard turns keep a local destination for conversation-log delivery
  // while Source records what produced the work.
  switch (source.platform) {
    case "slack": {
      if (destination.platform !== "slack") {
        throw new TypeError("Run source and destination platforms do not match");
      }
      if (source.teamId !== destination.teamId) {
        throw new TypeError("Slack source and destination teams do not match");
      }
      break;
    }
    case "api":
    case "local": {
      if (destination.platform !== "local") {
        throw new TypeError("Run source and destination platforms do not match");
      }
      if (source.conversationId !== destination.conversationId) {
        throw new TypeError(
          "Source and destination conversation IDs do not match",
        );
      }
      if (
        request.routing.surface !== "internal" &&
        destination.conversationId !== request.conversationId
      ) {
        throw new TypeError(
          "Source, destination, and run conversation IDs do not match",
        );
      }
      break;
    }
  }

  const actor = request.routing.dispatch?.actor ?? request.routing.actor;
  if (!actor || actor.platform === "system") {
    return;
  }
  const actorMatchesDestination = (() => {
    switch (actor.platform) {
      case "slack":
        return destination.platform === "slack";
      case "local":
        return destination.platform === "local";
      case "api":
        // API actors write through the local conversation-log destination.
        return destination.platform === "local";
    }
  })();
  if (!actorMatchesDestination) {
    throw new TypeError(
      `Actor platform "${actor.platform}" does not match destination platform "${destination.platform}"`,
    );
  }
  if (
    actor.platform === "slack" &&
    destination.platform === "slack" &&
    actor.teamId !== destination.teamId
  ) {
    throw new TypeError("Slack actor team does not match destination team");
  }
}

/** Route tool side effects to the tool channel when one overrides the destination. */
export function toolInvocationDestination(
  routing: AgentRunRouting,
): Destination {
  if (routing.destination.platform !== "slack" || !routing.toolChannelId) {
    return routing.destination;
  }
  return {
    platform: "slack",
    teamId: routing.destination.teamId,
    channelId: routing.toolChannelId,
  };
}

/** Infer the run surface when the caller did not state one. */
export function surfaceFromRouting(routing: AgentRunRouting): AgentTurnSurface {
  if (routing.surface) {
    return routing.surface;
  }
  if (routing.source.platform === "slack") {
    return "slack";
  }
  if (routing.source.platform === "api") {
    return "api";
  }
  return "internal";
}
