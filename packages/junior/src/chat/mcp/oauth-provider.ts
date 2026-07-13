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
  deleteMcpServerSessionId,
  getMcpAuthSession,
  getMcpServerSessionId,
  getMcpStoredOAuthCredentials,
  patchMcpAuthSession,
  putMcpServerSessionId,
  putMcpAuthSession,
  putMcpStoredOAuthCredentials,
  type McpAuthSessionState,
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

function clientAllowsRedirectUri(
  clientInformation: OAuthClientInformationMixed,
  callbackUrl: string,
): boolean {
  const redirectUris = (clientInformation as { redirect_uris?: unknown })
    .redirect_uris;
  if (!Array.isArray(redirectUris)) {
    return true;
  }
  return redirectUris.includes(callbackUrl);
}

export class StateBackedMcpOAuthClientProvider implements OAuthClientProvider {
  readonly clientMetadata: OAuthClientMetadata;

  constructor(
    readonly authSessionId: string,
    private readonly callbackUrl: string,
    private readonly sessionContext?: Omit<
      McpAuthSessionState,
      | "schemaVersion"
      | "authSessionId"
      | "authorizationUrl"
      | "codeVerifier"
      | "createdAtMs"
      | "updatedAtMs"
    >,
    private readonly runCredentialMutation?: <T>(
      mutation: () => Promise<T>,
    ) => Promise<T>,
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
    const session = await this.getCredentialContext();
    const credentials = await getMcpStoredOAuthCredentials(
      session.userId,
      session.provider,
    );
    const clientInformation = credentials?.clientInformation;
    if (!clientInformation) {
      return undefined;
    }
    if (clientAllowsRedirectUri(clientInformation, this.callbackUrl)) {
      return clientInformation;
    }
    return undefined;
  }

  async saveClientInformation(
    clientInformation: OAuthClientInformationMixed,
  ): Promise<void> {
    await this.mutateCredentials(async () => {
      const session = await this.getCredentialContext();
      const credentials =
        (await getMcpStoredOAuthCredentials(
          session.userId,
          session.provider,
        )) ?? {};
      await putMcpStoredOAuthCredentials(session.userId, session.provider, {
        ...credentials,
        clientInformation,
      });
    });
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    const session = await this.getCredentialContext();
    const credentials = await getMcpStoredOAuthCredentials(
      session.userId,
      session.provider,
    );
    return credentials?.tokens;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await this.mutateCredentials(async () => {
      const session = await this.getCredentialContext();
      const credentials =
        (await getMcpStoredOAuthCredentials(
          session.userId,
          session.provider,
        )) ?? {};
      await putMcpStoredOAuthCredentials(session.userId, session.provider, {
        ...credentials,
        tokens,
      });
    });
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    const existing = await getMcpAuthSession(this.authSessionId);
    if (
      existing?.authorizationUrl &&
      existing.authorizationUrl !== authorizationUrl.toString()
    ) {
      throw new Error("MCP OAuth authorization attempt is already initialized");
    }
    await this.ensureSession({
      authorizationUrl: authorizationUrl.toString(),
    });
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    const existing = await getMcpAuthSession(this.authSessionId);
    if (existing?.codeVerifier && existing.codeVerifier !== codeVerifier) {
      throw new Error("MCP OAuth authorization attempt is already initialized");
    }
    await this.ensureSession({ codeVerifier });
  }

  async codeVerifier(): Promise<string> {
    const session = await this.requireSession();
    if (!session.codeVerifier) {
      throw new Error("Missing MCP OAuth code verifier");
    }
    return session.codeVerifier;
  }

  async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
    await this.mutateCredentials(async () => {
      const session = await this.getCredentialContext();
      const credentials =
        (await getMcpStoredOAuthCredentials(
          session.userId,
          session.provider,
        )) ?? {};
      await putMcpStoredOAuthCredentials(session.userId, session.provider, {
        ...credentials,
        discoveryState: state,
      });
    });
  }

  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    const session = await this.getCredentialContext();
    const credentials = await getMcpStoredOAuthCredentials(
      session.userId,
      session.provider,
    );
    return credentials?.discoveryState;
  }

  async invalidateCredentials(
    scope: "all" | "client" | "tokens" | "verifier" | "discovery",
  ): Promise<void> {
    await this.mutateCredentials(async () => {
      const session = await this.getCredentialContext();
      const credentials =
        (await getMcpStoredOAuthCredentials(
          session.userId,
          session.provider,
        )) ?? {};

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
    });
  }

  async getMcpServerSessionId(): Promise<string | undefined> {
    const session = await this.getCredentialContext();
    return await getMcpServerSessionId(session.userId, session.provider);
  }

  async saveMcpServerSessionId(sessionId: string | undefined): Promise<void> {
    await this.mutateCredentials(async () => {
      const session = await this.getCredentialContext();
      if (!sessionId) {
        await deleteMcpServerSessionId(session.userId, session.provider);
        return;
      }

      await putMcpServerSessionId(session.userId, session.provider, sessionId);
    });
  }

  /** Route shared credential writes through callback-owned freshness control. */
  private async mutateCredentials<T>(mutation: () => Promise<T>): Promise<T> {
    return this.runCredentialMutation
      ? await this.runCredentialMutation(mutation)
      : await mutation();
  }

  private async getCredentialContext() {
    return this.sessionContext ?? (await this.requireSession());
  }

  private async ensureSession(patch: Partial<McpAuthSessionState>) {
    const existing = await getMcpAuthSession(this.authSessionId);
    if (existing) {
      return await patchMcpAuthSession(this.authSessionId, patch);
    }
    if (!this.sessionContext) {
      throw new Error(`Unknown MCP auth session: ${this.authSessionId}`);
    }

    const now = Date.now();
    const nextSession: McpAuthSessionState = {
      schemaVersion: 2,
      authSessionId: this.authSessionId,
      ...this.sessionContext,
      ...patch,
      createdAtMs: now,
      updatedAtMs: now,
    };
    await putMcpAuthSession(nextSession);
    return nextSession;
  }

  private async requireSession() {
    const session = await getMcpAuthSession(this.authSessionId);
    if (!session) {
      throw new Error(`Unknown MCP auth session: ${this.authSessionId}`);
    }
    return session;
  }
}
