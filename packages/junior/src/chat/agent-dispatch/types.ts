import type { DispatchOptions as AgentPluginDispatchOptions } from "@sentry/junior-plugin-api";
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

export type DispatchOptions = AgentPluginDispatchOptions;

export type DispatchDestination = DispatchOptions["destination"];

export interface BoundDispatchOptions extends Omit<
  DispatchOptions,
  "credentialSubject"
> {
  credentialSubject?: CredentialSubject;
}

export interface DispatchRecord {
  actor: CredentialSystemActor;
  attempt: number;
  createdAtMs: number;
  credentialSubject?: CredentialSubject;
  destination: DispatchDestination;
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
