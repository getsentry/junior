import type {
  DispatchOptions,
  DestinationVisibility,
  Source,
  SlackDestination,
} from "@sentry/junior-plugin-api";
import type {
  CredentialSubject,
  CredentialSystemActor,
} from "@/chat/credentials/context";

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
  attempt: number;
  createdAtMs: number;
  credentialSubject?: CredentialSubject;
  destination: SlackDestination;
  destinationVisibility: DestinationVisibility;
  errorMessage?: string;
  id: string;
  idempotencyKey: string;
  input: string;
  lastCallbackAtMs?: number;
  leaseExpiresAtMs?: number;
  maxAttempts: number;
  metadata?: Record<string, string>;
  plugin: string;
  resultMessageTs?: string;
  source: Source;
  status: DispatchStatus;
  updatedAtMs: number;
  version: number;
}

export interface DispatchProjection {
  errorMessage?: string;
  id: string;
  resultMessageTs?: string;
  status: DispatchStatus;
}

export interface DispatchCallback {
  expectedVersion: number;
  id: string;
}

export interface DispatchCreateResult {
  record: DispatchRecord;
  status: "created" | "already_exists";
}
