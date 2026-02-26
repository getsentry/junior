import type { CapabilityTarget } from "@/chat/capabilities/types";

export interface CredentialLease {
  id: string;
  provider: string;
  capability: string;
  env: Record<string, string>;
  expiresAt: string;
  metadata?: Record<string, string>;
}

export interface CredentialBroker {
  issue(input: {
    capability: string;
    target?: CapabilityTarget;
    reason: string;
  }): Promise<CredentialLease>;
}
