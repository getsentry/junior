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
 * A host-minted bot credential could not be issued.
 *
 * No user can fix this by connecting an account, so egress reports it as
 * unavailable instead of starting an auth flow. The message names the failing
 * step and never includes token values.
 */
export class CredentialMintError extends Error {
  readonly provider: string;

  constructor(provider: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CredentialMintError";
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
