import type { CredentialContext } from "@/chat/credentials/context";

export class CredentialUnavailableError extends Error {
  readonly provider: string;

  constructor(provider: string, message: string) {
    super(message);
    this.name = "CredentialUnavailableError";
    this.provider = provider;
  }
}

/**
 * The plugin uses only its service account, and that account cannot serve
 * this request. Asking the Actor to connect would not help.
 */
export class ServiceAccountUnavailableError extends CredentialUnavailableError {
  constructor(provider: string, message: string) {
    super(provider, message);
    this.name = "ServiceAccountUnavailableError";
  }
}

export type CredentialHeaderTransform = {
  domain: string;
  headers: Record<string, string>;
};

export interface CredentialLease {
  id: string;
  provider: string;
  env: Record<string, string>;
  headerTransforms?: CredentialHeaderTransform[];
  expiresAt: string;
  metadata?: Record<string, string>;
}

export interface CredentialBroker {
  issue(input: {
    context: CredentialContext;
    /** Operation that plugin host code passed to `egress.fetch`. */
    operation?: string;
    reason: string;
  }): Promise<CredentialLease>;
}
