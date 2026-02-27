import { getCapabilityProvider } from "@/chat/capabilities/catalog";
import type { CredentialBroker, CredentialLease } from "@/chat/credentials/broker";
import type { CapabilityTarget } from "@/chat/capabilities/types";

export interface CapabilityCredentialRouter {
  issue(input: {
    capability: string;
    target?: CapabilityTarget;
    reason: string;
  }): Promise<CredentialLease>;
}

export class ProviderCredentialRouter implements CapabilityCredentialRouter {
  private readonly brokersByProvider: Record<string, CredentialBroker>;

  constructor(input: { brokersByProvider: Record<string, CredentialBroker> }) {
    this.brokersByProvider = input.brokersByProvider;
  }

  async issue(input: {
    capability: string;
    target?: CapabilityTarget;
    reason: string;
  }): Promise<CredentialLease> {
    const provider = getCapabilityProvider(input.capability)?.provider;
    if (!provider) {
      throw new Error(`Unsupported capability: ${input.capability}`);
    }

    const broker = this.brokersByProvider[provider];
    if (!broker) {
      throw new Error(`No credential broker registered for provider: ${provider}`);
    }

    return await broker.issue(input);
  }
}
