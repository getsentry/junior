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

interface StateBackedMcpOAuthClientProviderServices {
  deleteMcpServerSessionId: typeof deleteMcpServerSessionId;
  getMcpAuthSession: typeof getMcpAuthSession;
  getMcpServerSessionId: typeof getMcpServerSessionId;
  getMcpStoredOAuthCredentials: typeof getMcpStoredOAuthCredentials;
  now: () => number;
  patchMcpAuthSession: typeof patchMcpAuthSession;
  putMcpAuthSession: typeof putMcpAuthSession;
  putMcpServerSessionId: typeof putMcpServerSessionId;
  putMcpStoredOAuthCredentials: typeof putMcpStoredOAuthCredentials;
}

const defaultStateBackedMcpOAuthClientProviderServices: StateBackedMcpOAuthClientProviderServices =
  {
    deleteMcpServerSessionId,
    getMcpAuthSession,
    getMcpServerSessionId,
    getMcpStoredOAuthCredentials,
    now: Date.now,
    patchMcpAuthSession,
    putMcpAuthSession,
    putMcpServerSessionId,
    putMcpStoredOAuthCredentials,
  };

type McpOAuthSessionContext = Omit<
  McpAuthSessionState,
  | "authSessionId"
  | "authorizationUrl"
  | "codeVerifier"
  | "createdAtMs"
  | "updatedAtMs"
>;

function createClientMetadata(callbackUrl: string): OAuthClientMetadata {
  return {
    client_name: "Junior MCP Client",
    redirect_uris: [callbackUrl],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  };
}

/** OAuth client provider backed by Junior's MCP auth-session state store. */
export class StateBackedMcpOAuthClientProvider implements OAuthClientProvider {
  readonly clientMetadata: OAuthClientMetadata;

  constructor(
    readonly authSessionId: string,
    private readonly callbackUrl: string,
    private readonly sessionContext?: McpOAuthSessionContext,
    private readonly services: StateBackedMcpOAuthClientProviderServices = defaultStateBackedMcpOAuthClientProviderServices,
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
    const credentials = await this.services.getMcpStoredOAuthCredentials(
      session.userId,
      session.provider,
    );
    return credentials?.clientInformation;
  }

  async saveClientInformation(
    clientInformation: OAuthClientInformationMixed,
  ): Promise<void> {
    const session = await this.getCredentialContext();
    const credentials =
      (await this.services.getMcpStoredOAuthCredentials(
        session.userId,
        session.provider,
      )) ?? {};
    await this.services.putMcpStoredOAuthCredentials(
      session.userId,
      session.provider,
      {
        ...credentials,
        clientInformation,
      },
    );
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    const session = await this.getCredentialContext();
    const credentials = await this.services.getMcpStoredOAuthCredentials(
      session.userId,
      session.provider,
    );
    return credentials?.tokens;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    const session = await this.getCredentialContext();
    const credentials =
      (await this.services.getMcpStoredOAuthCredentials(
        session.userId,
        session.provider,
      )) ?? {};
    await this.services.putMcpStoredOAuthCredentials(
      session.userId,
      session.provider,
      {
        ...credentials,
        tokens,
      },
    );
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    await this.ensureSession({
      authorizationUrl: authorizationUrl.toString(),
    });
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
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
    const session = await this.getCredentialContext();
    const credentials =
      (await this.services.getMcpStoredOAuthCredentials(
        session.userId,
        session.provider,
      )) ?? {};
    await this.services.putMcpStoredOAuthCredentials(
      session.userId,
      session.provider,
      {
        ...credentials,
        discoveryState: state,
      },
    );
  }

  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    const session = await this.getCredentialContext();
    const credentials = await this.services.getMcpStoredOAuthCredentials(
      session.userId,
      session.provider,
    );
    return credentials?.discoveryState;
  }

  async invalidateCredentials(
    scope: "all" | "client" | "tokens" | "verifier" | "discovery",
  ): Promise<void> {
    const session = await this.getCredentialContext();
    const credentials =
      (await this.services.getMcpStoredOAuthCredentials(
        session.userId,
        session.provider,
      )) ?? {};

    await this.services.putMcpStoredOAuthCredentials(
      session.userId,
      session.provider,
      {
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
      },
    );

    if (scope === "verifier" || scope === "all") {
      const authSession = await this.services.getMcpAuthSession(
        this.authSessionId,
      );
      if (authSession) {
        await this.services.patchMcpAuthSession(this.authSessionId, {
          codeVerifier: undefined,
          ...(scope === "all" ? { authorizationUrl: undefined } : {}),
        });
      }
    }
  }

  async getMcpServerSessionId(): Promise<string | undefined> {
    const session = await this.getCredentialContext();
    return await this.services.getMcpServerSessionId(
      session.userId,
      session.provider,
    );
  }

  async saveMcpServerSessionId(sessionId: string | undefined): Promise<void> {
    const session = await this.getCredentialContext();
    if (!sessionId) {
      await this.services.deleteMcpServerSessionId(
        session.userId,
        session.provider,
      );
      return;
    }

    await this.services.putMcpServerSessionId(
      session.userId,
      session.provider,
      sessionId,
    );
  }

  private async getCredentialContext() {
    return this.sessionContext ?? (await this.requireSession());
  }

  private async ensureSession(patch: Partial<McpAuthSessionState>) {
    const existing = await this.services.getMcpAuthSession(this.authSessionId);
    if (existing) {
      return await this.services.patchMcpAuthSession(this.authSessionId, patch);
    }
    if (!this.sessionContext) {
      throw new Error(`Unknown MCP auth session: ${this.authSessionId}`);
    }

    const now = this.services.now();
    const nextSession: McpAuthSessionState = {
      authSessionId: this.authSessionId,
      ...this.sessionContext,
      ...patch,
      createdAtMs: now,
      updatedAtMs: now,
    };
    await this.services.putMcpAuthSession(nextSession);
    return nextSession;
  }

  private async requireSession() {
    const session = await this.services.getMcpAuthSession(this.authSessionId);
    if (!session) {
      throw new Error(`Unknown MCP auth session: ${this.authSessionId}`);
    }
    return session;
  }
}
