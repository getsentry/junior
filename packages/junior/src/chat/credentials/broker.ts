export class CredentialUnavailableError extends Error {
  readonly provider: string;

  constructor(provider: string, message: string) {
    super(message);
    this.name = "CredentialUnavailableError";
    this.provider = provider;
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
    reason: string;
    requesterId?: string;
  }): Promise<CredentialLease>;
}
