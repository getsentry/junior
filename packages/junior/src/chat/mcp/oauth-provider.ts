import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type {
  OAuthClientProvider,
  OAuthDiscoveryState,
} from "@modelcontextprotocol/sdk/client/auth.js";
import {
  getMcpAuthSession,
  getMcpStoredOAuthCredentials,
  patchMcpAuthSession,
  putMcpStoredOAuthCredentials,
} from "./auth-store";

function createClientMetadata(callbackUrl: string): OAuthClientMetadata {
  return {
    client_name: "Junior MCP Client",
    redirect_uris: [callbackUrl],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  };
}

export class StateBackedMcpOAuthClientProvider implements OAuthClientProvider {
  readonly clientMetadata: OAuthClientMetadata;

  constructor(
    readonly authSessionId: string,
    private readonly callbackUrl: string,
  ) {
    this.clientMetadata = createClientMetadata(callbackUrl);
  }

  get redirectUrl(): string {
    return this.callbackUrl;
  }

  async state(): Promise<string> {
    return this.authSessionId;
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    const session = await this.requireSession();
    const credentials = await getMcpStoredOAuthCredentials(
      session.userId,
      session.provider,
    );
    return credentials?.clientInformation;
  }

  async saveClientInformation(
    clientInformation: OAuthClientInformationMixed,
  ): Promise<void> {
    const session = await this.requireSession();
    const credentials =
      (await getMcpStoredOAuthCredentials(session.userId, session.provider)) ??
      {};
    await putMcpStoredOAuthCredentials(session.userId, session.provider, {
      ...credentials,
      clientInformation,
    });
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    const session = await this.requireSession();
    const credentials = await getMcpStoredOAuthCredentials(
      session.userId,
      session.provider,
    );
    return credentials?.tokens;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    const session = await this.requireSession();
    const credentials =
      (await getMcpStoredOAuthCredentials(session.userId, session.provider)) ??
      {};
    await putMcpStoredOAuthCredentials(session.userId, session.provider, {
      ...credentials,
      tokens,
    });
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    await patchMcpAuthSession(this.authSessionId, {
      authorizationUrl: authorizationUrl.toString(),
    });
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    await patchMcpAuthSession(this.authSessionId, { codeVerifier });
  }

  async codeVerifier(): Promise<string> {
    const session = await this.requireSession();
    if (!session.codeVerifier) {
      throw new Error("Missing MCP OAuth code verifier");
    }
    return session.codeVerifier;
  }

  async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
    const session = await this.requireSession();
    const credentials =
      (await getMcpStoredOAuthCredentials(session.userId, session.provider)) ??
      {};
    await putMcpStoredOAuthCredentials(session.userId, session.provider, {
      ...credentials,
      discoveryState: state,
    });
  }

  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    const session = await this.requireSession();
    const credentials = await getMcpStoredOAuthCredentials(
      session.userId,
      session.provider,
    );
    return credentials?.discoveryState;
  }

  async invalidateCredentials(
    scope: "all" | "client" | "tokens" | "verifier" | "discovery",
  ): Promise<void> {
    const session = await this.requireSession();
    const credentials =
      (await getMcpStoredOAuthCredentials(session.userId, session.provider)) ??
      {};

    await putMcpStoredOAuthCredentials(session.userId, session.provider, {
      ...(scope === "tokens" || scope === "all"
        ? {}
        : credentials.tokens
          ? { tokens: credentials.tokens }
          : {}),
      ...(scope === "client" || scope === "all"
        ? {}
        : credentials.clientInformation
          ? { clientInformation: credentials.clientInformation }
          : {}),
      ...(scope === "discovery" || scope === "all"
        ? {}
        : credentials.discoveryState
          ? { discoveryState: credentials.discoveryState }
          : {}),
    });

    if (scope === "verifier" || scope === "all") {
      await patchMcpAuthSession(this.authSessionId, {
        codeVerifier: undefined,
        authorizationUrl: scope === "all" ? undefined : undefined,
      });
    }
  }

  private async requireSession() {
    const session = await getMcpAuthSession(this.authSessionId);
    if (!session) {
      throw new Error(`Unknown MCP auth session: ${this.authSessionId}`);
    }
    return session;
  }
}
