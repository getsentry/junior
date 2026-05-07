import type {
  CredentialBroker,
  CredentialLease,
} from "@/chat/credentials/broker";

export interface CredentialRouter {
  issue(input: {
    provider: string;
    reason: string;
    requesterId?: string;
  }): Promise<CredentialLease>;
}

export class ProviderCredentialRouter implements CredentialRouter {
  private readonly brokersByProvider: Record<string, CredentialBroker>;

  constructor(input: { brokersByProvider: Record<string, CredentialBroker> }) {
    this.brokersByProvider = input.brokersByProvider;
  }

  async issue(input: {
    provider: string;
    reason: string;
    requesterId?: string;
  }): Promise<CredentialLease> {
    const broker = this.brokersByProvider[input.provider];
    if (!broker) {
      throw new Error(
        `No credential broker registered for provider: ${input.provider}`,
      );
    }

    return await broker.issue({
      reason: input.reason,
      requesterId: input.requesterId,
    });
  }
}
