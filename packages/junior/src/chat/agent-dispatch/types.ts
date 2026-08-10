import type {
  DispatchOptions,
  DestinationVisibility,
  ReplyAttribution,
  Source,
  SlackDestination,
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
};

export interface BoundDispatchOptions extends Omit<
  SlackDispatchOptions,
  "credentialSubject"
> {
  credentialSubject?: CredentialSubject;
}

export interface DispatchRecord {
  actor: CredentialSystemActor;
  createdAtMs: number;
  credentialSubject?: CredentialSubject;
  destination: SlackDestination;
  destinationVisibility: DestinationVisibility;
  errorMessage?: string;
  id: string;
  idempotencyKey: string;
  input: string;
  metadata?: Record<string, string>;
  plugin: string;
  replyAttribution?: ReplyAttribution;
  resultMessageTs?: string;
  source: Source;
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
