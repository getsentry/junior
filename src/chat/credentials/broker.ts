import type { CapabilityTarget } from "@/chat/capabilities/types";

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
  capability: string;
  env: Record<string, string>;
  headerTransforms?: CredentialHeaderTransform[];
  expiresAt: string;
  metadata?: Record<string, string>;
}

export interface CredentialBroker {
  issue(input: {
    capability: string;
    target?: CapabilityTarget;
    reason: string;
    requesterId?: string;
  }): Promise<CredentialLease>;
}
