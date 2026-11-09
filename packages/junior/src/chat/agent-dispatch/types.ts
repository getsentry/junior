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
  source:
    | EventAutomationSource
    | PluginDispatchSource
    | ScheduledAutomationSource;
}

/**
 * One dispatch lifecycle state. Each state carries only the facts that are
 * valid in it: a result message exists only after the run ended, and an error
 * exists only on a failed or blocked run.
 */
export type DispatchState =
  | {
      status: "pending" | "running" | "awaiting_resume";
      errorMessage?: never;
      resultMessageTs?: never;
    }
  | { status: "completed"; errorMessage?: never; resultMessageTs?: string }
  | {
      status: "blocked" | "failed";
      errorMessage: string;
      resultMessageTs?: string;
    };

/** A legal next state. A dispatch never moves back to `pending`. */
export type DispatchChange = DispatchState & {
  status: Exclude<DispatchStatus, "pending">;
};

export type DispatchRecord = {
  actor: CredentialSystemActor;
  createdAtMs: number;
  credentialSubject?: CredentialSubject;
  destination: SlackDestination;
  destinationVisibility: DestinationVisibility;
  id: string;
  idempotencyKey: string;
  input: string;
  metadata?: Record<string, string>;
  plugin: string;
  replyAttribution?: ReplyAttribution;
  source: Source;
  /** Visible effects after successful work. */
  outcomes?: TaskOutcome[];
  updatedAtMs: number;
} & DispatchState;

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
  dispatch: AgentDispatch;
  skipProviderDefaultConfig: true;
  source: Source;
  surface: Extract<AgentTurnSurface, "api">;
  turnId: string;
}
