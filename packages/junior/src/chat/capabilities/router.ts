import type {
  CredentialBroker,
  CredentialLease,
} from "@/chat/credentials/broker";
import type { CredentialContext } from "@/chat/credentials/context";

export interface CredentialRouter {
  issue(input: {
    context: CredentialContext;
    provider: string;
    reason: string;
  }): Promise<CredentialLease>;
}

export class ProviderCredentialRouter implements CredentialRouter {
  private readonly brokersByProvider: Record<string, CredentialBroker>;

  constructor(input: { brokersByProvider: Record<string, CredentialBroker> }) {
    this.brokersByProvider = input.brokersByProvider;
  }

  async issue(input: {
    context: CredentialContext;
    provider: string;
    reason: string;
  }): Promise<CredentialLease> {
    const broker = this.brokersByProvider[input.provider];
    if (!broker) {
      throw new Error(
        `No credential broker registered for provider: ${input.provider}`,
      );
    }

    return await broker.issue({
      context: input.context,
      reason: input.reason,
    });
  }
}
