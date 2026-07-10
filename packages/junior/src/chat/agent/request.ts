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
  Source,
  SystemActor,
} from "@sentry/junior-plugin-api";
import type { ChannelConfigurationService } from "@/chat/configuration/types";
import type { CredentialContext } from "@/chat/credentials/context";
import type { PiMessage } from "@/chat/pi/messages";
import { createActor, isUserActor, type Actor } from "@/chat/actor";
import type { SandboxAcquiredState } from "@/chat/sandbox/sandbox";
import type { SandboxEgressTracePropagationConfig } from "@/chat/sandbox/egress/tracing";
import type { AuthorizationFlowMode } from "@/chat/services/auth-pause";
import type { AssistantStatusSpec } from "@/chat/slack/assistant-thread/status";
import type { SlackConversationContext } from "@/chat/slack/conversation-context";
import { parseSlackThreadId } from "@/chat/slack/context";
import type { ThreadArtifactsState } from "@/chat/state/artifacts";
import type { ConversationPendingAuthState } from "@/chat/state/conversation";
import type { PiMessageProvenance } from "@/chat/state/session-log";
import type { AgentTurnSurface } from "@/chat/state/turn-session";
import type { ToolExecutionReport } from "@/chat/tool-support/tool-execution-report";
import type {
  ImageGenerateToolDeps,
  WebFetchToolDeps,
  WebSearchToolDeps,
} from "@/chat/tools/types";

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
  provenance: PiMessageProvenance;
  omittedImageAttachmentCount?: number;
  text: string;
  timestampMs?: number;
  userAttachments?: AgentRunAttachment[];
}

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

/** Carries identity and addressing needed to route tools, auth, and delivery. */
export interface AgentRunRouting {
  credentialContext?: CredentialContext;
  actor?: Actor;
  source: Source;
  slackConversation?: SlackConversationContext;
  destination: Destination;
  surface?: AgentTurnSurface;
  dispatch?: {
    actor?: SystemActor;
    metadata?: Record<string, string>;
    plugin?: string;
  };
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
    actorId?: string;
  };
  toolChannelId?: string;
}

/** Carries execution limits and dependency overrides for one run slice. */
export interface AgentRunPolicy {
  /** Absolute wall-clock deadline for this host request, in milliseconds. */
  turnDeadlineAtMs?: number;
  /** Cancels provider work when the owning host request is abandoned. */
  signal?: AbortSignal;
  authorizationFlowMode?: AuthorizationFlowMode;
  configuration?: Record<string, unknown>;
  channelConfiguration?: ChannelConfigurationService;
  skillDirs?: string[];
  /** Per-slice override for app-owned sandbox egress trace propagation. */
  sandboxTracePropagation?: SandboxEgressTracePropagationConfig;
  toolOverrides?: {
    imageGenerate?: ImageGenerateToolDeps;
    webFetch?: WebFetchToolDeps;
    webSearch?: WebSearchToolDeps;
  };
}

/** Carries durable state snapshots already loaded by the caller. */
export interface AgentRunState {
  artifactState?: ThreadArtifactsState;
  pendingAuth?: ConversationPendingAuthState;
  /** Persisted sandbox reuse state from prior slices of this conversation. */
  sandbox?: {
    sandboxId?: string;
    sandboxDependencyProfileHash?: string;
  };
}

/**
 * Carries notification-only callbacks for streaming UI and status surfaces;
 * their failures never affect the run.
 */
export interface AgentRunObservers {
  onTextDelta?: (deltaText: string) => void | Promise<void>;
  onAssistantMessageStart?: () => void | Promise<void>;
  onToolInvocation?: (invocation: {
    toolName: string;
    params: Record<string, unknown>;
  }) => void | Promise<void>;
  onToolResult?: (result: ToolExecutionReport) => void | Promise<void>;
  onStatus?: (status: AssistantStatusSpec) => void | Promise<void>;
}

/** Carries durable-worker ports that commit or update resumable run state. */
export interface AgentRunDurability {
  onInputCommitted?: () => void | Promise<void>;
  /** Return true when the durable worker should pause at the next Pi boundary. */
  shouldYield?: () => boolean;
  drainSteeringMessages?: (
    accept: (messages: AgentRunSteeringMessage[]) => Promise<void>,
  ) => Promise<AgentRunSteeringMessage[]>;
  recordPendingAuth?: (
    pendingAuth: ConversationPendingAuthState,
  ) => void | Promise<void>;
  onSandboxAcquired?: (sandbox: SandboxAcquiredState) => void | Promise<void>;
  onArtifactStateUpdated?: (
    artifactState: ThreadArtifactsState,
  ) => void | Promise<void>;
}

/** Groups the per-slice run request by the runtime role each field serves. */
export interface AgentRunRequest {
  input: AgentRunInput;
  routing: AgentRunRouting;
  policy?: AgentRunPolicy;
  state?: AgentRunState;
  observers?: AgentRunObservers;
  durability?: AgentRunDurability;
}

/** Extract conversation and session identifiers from correlation context. */
export function getSessionIdentifiers(routing: AgentRunRouting): {
  conversationId?: string;
  sessionId?: string;
} {
  return {
    conversationId:
      routing.correlation?.conversationId ??
      routing.correlation?.threadId ??
      routing.correlation?.runId,
    sessionId: routing.correlation?.turnId,
  };
}

/** Derive the acting actor, filling platform and team from the destination. */
export function actorFromRouting(routing: AgentRunRouting): Actor | undefined {
  if (routing.dispatch?.actor) {
    return routing.dispatch.actor;
  }
  const userActor = createActor(
    isUserActor(routing.actor) ? routing.actor : undefined,
    {
      platform:
        (isUserActor(routing.actor) ? routing.actor.platform : undefined) ??
        (routing.destination.platform === "slack" ? "slack" : undefined),
      teamId:
        (routing.destination.platform === "slack"
          ? routing.destination.teamId
          : undefined) ??
        routing.correlation?.teamId ??
        (routing.actor?.platform === "slack"
          ? routing.actor.teamId
          : undefined),
      userId: routing.correlation?.actorId,
    },
  );
  if (userActor) {
    return userActor;
  }
  if (
    routing.credentialContext &&
    !("type" in routing.credentialContext.actor)
  ) {
    return routing.credentialContext.actor;
  }
  return undefined;
}

/** Reject actor identities that do not belong to the active destination. */
export function assertActorDestinationMatch(routing: AgentRunRouting): void {
  const { destination, actor } = routing;
  if (!actor) {
    return;
  }
  if (actor.platform !== destination.platform) {
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

/** Reject legacy Slack correlation fields that conflict with the destination. */
export function assertCorrelationDestinationMatch(
  routing: AgentRunRouting,
): void {
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
export function surfaceFromRouting(
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
