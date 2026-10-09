import type {
  DispatchOptions,
  DestinationVisibility,
  EventAutomationSource,
  PluginDispatchSource,
  ReplyAttribution,
  ScheduledAutomationSource,
  Source,
  SlackDestination,
  TaskOutcome,
} from "@sentry/junior-plugin-api";
import type {
  CredentialContext,
  CredentialSubject,
  CredentialSystemActor,
} from "@/chat/credentials/context";
import type { AgentDispatch } from "@/chat/agent/types";
import type { AgentTurnSurface } from "@/chat/task-execution/checkpoint";
import type { LocationConfigurationService } from "@/chat/configuration/types";

export type DispatchStatus =
  | "pending"
  | "running"
  | "awaiting_resume"
  | "completed"
  | "failed"
  | "blocked";

export type SlackDispatchOptions = Omit<DispatchOptions, "destination"> & {
  destination: SlackDestination;
  outcomes?: TaskOutcome[];
};

export interface BoundDispatchOptions extends Omit<
  SlackDispatchOptions,
  "credentialSubject"
> {
  credentialSubject?: CredentialSubject;
  /**
   * Shared Conversation for related dispatches. Omit it to run the dispatch in
   * its own Conversation.
   */
  conversationId?: string;
  source:
    | EventAutomationSource
    | PluginDispatchSource
    | ScheduledAutomationSource;
}

export interface DispatchRecord {
  actor: CredentialSystemActor;
  /** Shared Conversation id. Omitted when the dispatch owns its Conversation. */
  conversationId?: string;
  createdAtMs: number;
  credentialSubject?: CredentialSubject;
  destination: SlackDestination;
  destinationVisibility: DestinationVisibility;
  errorMessage?: string;
  id: string;
  idempotencyKey: string;
  input: string;
  /**
   * Dispatches whose input this dispatch's Turn holds. Set when the Turn
   * starts, so a resumed Turn knows which mailbox dispatches it already ran.
   */
  joinedDispatchIds?: string[];
  metadata?: Record<string, string>;
  plugin: string;
  replyAttribution?: ReplyAttribution;
  resultMessageTs?: string;
  source: Source;
  /** Visible effects after successful work. */
  outcomes?: TaskOutcome[];
  status: DispatchStatus;
  updatedAtMs: number;
}

export interface DispatchProjection {
  errorMessage?: string;
  id: string;
  resultMessageTs?: string;
  status: DispatchStatus;
}

export interface DispatchCreateResult {
  record: DispatchRecord;
  status: "created" | "already_exists";
}

export type DispatchTurnOutcome =
  | "awaiting_resume"
  | "blocked"
  | "completed"
  | "failed";

/** Facts returned by one attempt to advance a dispatched turn. */
export interface DispatchTurnResult {
  errorMessage?: string;
  outcome?: DispatchTurnOutcome;
  resultMessageTs?: string;
}

/** Dispatch-owned authority supplied to the shared turn runtime. */
export interface DispatchTurnContext {
  disabledFeatures: readonly ["interactive-auth"];
  locationConfiguration: LocationConfigurationService;
  credentialContext: CredentialContext;
  destinationVisibility: DestinationVisibility;
  dispatch: AgentDispatch;
  skipProviderDefaultConfig: true;
  source: Source;
  surface: Extract<AgentTurnSurface, "api">;
  turnId: string;
}
