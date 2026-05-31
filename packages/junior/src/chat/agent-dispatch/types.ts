export type DispatchStatus =
  | "pending"
  | "running"
  | "awaiting_resume"
  | "completed"
  | "failed"
  | "blocked";

export interface DispatchActor {
  type: "system";
  id: string;
}

export interface DispatchDestination {
  platform: "slack";
  teamId: string;
  channelId: string;
}

export interface DispatchCredentialSubject {
  type: "user";
  userId: string;
  allowedWhen: "private-direct-conversation";
}

export interface DispatchOptions {
  credentialSubject?: DispatchCredentialSubject;
  destination: DispatchDestination;
  idempotencyKey: string;
  input: string;
  metadata?: Record<string, string>;
}

export interface DispatchRecord {
  actor: DispatchActor;
  attempt: number;
  createdAtMs: number;
  credentialSubject?: DispatchCredentialSubject;
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
