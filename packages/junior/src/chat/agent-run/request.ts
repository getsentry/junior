import type { Destination, Source } from "@sentry/junior-plugin-api";
import type { SandboxAcquiredState } from "@/chat/sandbox/sandbox";
import type { SandboxEgressTracePropagationConfig } from "@/chat/sandbox/egress/tracing";
import type { AssistantStatusSpec } from "@/chat/slack/assistant-thread/status";
import type { SlackConversationContext } from "@/chat/slack/conversation-context";
import type { ThreadArtifactsState } from "@/chat/state/artifacts";
import type { ConversationPendingAuthState } from "@/chat/state/conversation";
import type { AgentTurnSurface } from "@/chat/state/turn-session";
import type { CredentialContext } from "@/chat/credentials/context";
import type { Requester } from "@/chat/requester";
import type { ChannelConfigurationService } from "@/chat/configuration/types";
import type {
  ImageGenerateToolDeps,
  WebFetchToolDeps,
  WebSearchToolDeps,
} from "@/chat/tools/types";
import type { ToolExecutionReport } from "@/chat/tools/agent-tools";
import type { AuthorizationFlowMode } from "@/chat/services/auth-pause";
import type { PiMessage } from "@/chat/pi/messages";

/** Carries the user-visible content and prior transcript for one agent-run slice. */
export interface AgentRunInput {
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
  requester?: Requester;
  source: Source;
  slackConversation?: SlackConversationContext;
  destination: Destination;
  surface?: AgentTurnSurface;
  dispatch?: {
    actor?: { id: string; type: string };
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
    requesterId?: string;
  };
  toolChannelId?: string;
}

/** Carries execution limits and dependency overrides for one run slice. */
export interface AgentRunPolicy {
  /** Absolute wall-clock deadline for this host request, in milliseconds. */
  turnDeadlineAtMs?: number;
  authorizationFlowMode?: AuthorizationFlowMode;
  configuration?: Record<string, unknown>;
  channelConfiguration?: ChannelConfigurationService;
  skillDirs?: string[];
  sandbox?: {
    sandboxId?: string;
    sandboxDependencyProfileHash?: string;
    /** Per-slice override for app-owned sandbox egress trace propagation. */
    tracePropagation?: SandboxEgressTracePropagationConfig;
  };
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
}

/** Carries non-blocking notifications for streaming UI and status surfaces. */
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

/** Groups the per-slice agent-run request by the runtime role each field serves. */
export interface AgentRunRequest {
  input: AgentRunInput;
  routing: AgentRunRouting;
  policy?: AgentRunPolicy;
  state?: AgentRunState;
  observers?: AgentRunObservers;
  durability?: AgentRunDurability;
}

export interface AgentRunAttachment {
  data?: Buffer;
  mediaType: string;
  filename?: string;
  promptText?: string;
}

export interface AgentRunSteeringMessage {
  omittedImageAttachmentCount?: number;
  text: string;
  timestampMs?: number;
  userAttachments?: AgentRunAttachment[];
}
