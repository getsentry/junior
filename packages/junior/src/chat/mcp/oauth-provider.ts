import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type {
  OAuthClientProvider,
  OAuthDiscoveryState,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type { PluginMcpOAuthClientConfig } from "@sentry/junior-plugin-api";
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

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`MCP OAuth client env var ${name} is unset`);
  }
  return value;
}

export class StateBackedMcpOAuthClientProvider implements OAuthClientProvider {
  readonly clientMetadata: OAuthClientMetadata;

  readonly authSessionId: string;
  private readonly callbackUrl: string;
  private readonly sessionContext:
    | Omit<
        McpAuthSessionState,
        | "schemaVersion"
        | "authSessionId"
        | "authorizationUrl"
        | "codeVerifier"
        | "createdAtMs"
        | "updatedAtMs"
      >
    | undefined;
  private readonly runCredentialMutation:
    | (<T>(mutation: () => Promise<T>) => Promise<T>)
    | undefined;
  private readonly oauthClient: PluginMcpOAuthClientConfig | undefined;
  private ignoresStoredTokens = false;

  constructor(
    authSessionId: string,
    callbackUrl: string,
    sessionContext?: Omit<
      McpAuthSessionState,
      | "schemaVersion"
      | "authSessionId"
      | "authorizationUrl"
      | "codeVerifier"
      | "createdAtMs"
      | "updatedAtMs"
    >,
    runCredentialMutation?: <T>(mutation: () => Promise<T>) => Promise<T>,
    oauthClient?: PluginMcpOAuthClientConfig,
  ) {
    this.authSessionId = authSessionId;
    this.callbackUrl = callbackUrl;
    this.sessionContext = sessionContext;
    this.runCredentialMutation = runCredentialMutation;
    this.oauthClient = oauthClient;
    this.clientMetadata = createClientMetadata(callbackUrl);
  }

  get redirectUrl(): string {
    return this.callbackUrl;
  }

  async state(): Promise<string> {
    return this.authSessionId;
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    if (this.oauthClient) {
      return {
        client_id: requireEnv(this.oauthClient.clientIdEnv),
        client_secret: requireEnv(this.oauthClient.clientSecretEnv),
      };
    }
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

  /**
   * A provider for this authorization attempt that starts a new sign-in
   * instead of a refresh. The stored tokens stay until the new sign-in
   * replaces them, so a person who never finishes it keeps their access.
   */
  forNewSignIn(): StateBackedMcpOAuthClientProvider {
    const provider = new StateBackedMcpOAuthClientProvider(
      this.authSessionId,
      this.callbackUrl,
      this.sessionContext,
      this.runCredentialMutation,
      this.oauthClient,
    );
    provider.ignoresStoredTokens = true;
    return provider;
  }

  /** The scope that the person's last finished sign-in asked for. */
  async lastSignInScope(): Promise<string | undefined> {
    const session = await this.getCredentialContext();
    const credentials = await getMcpStoredOAuthCredentials(
      session.userId,
      session.provider,
    );
    return credentials?.signInScope;
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    if (this.ignoresStoredTokens) {
      return undefined;
    }
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
      // A sign-in replaces the scope it asked for. A refresh keeps it.
      const authorizationUrl = (await getMcpAuthSession(this.authSessionId))
        ?.authorizationUrl;
      const { signInScope: previousScope, ...rest } = credentials;
      const signInScope = authorizationUrl
        ? (new URL(authorizationUrl).searchParams.get("scope") ?? undefined)
        : previousScope;
      await putMcpStoredOAuthCredentials(session.userId, session.provider, {
        ...rest,
        ...(signInScope ? { signInScope } : undefined),
        tokens,
      });
    });
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    // The SDK requests every scope the server advertises. A pre-registered
    // client may need a narrower scope and provider-specific parameters.
    if (this.oauthClient?.scope) {
      authorizationUrl.searchParams.set("scope", this.oauthClient.scope);
    }
    for (const [key, value] of Object.entries(
      this.oauthClient?.authorizeParams ?? {},
    )) {
      authorizationUrl.searchParams.set(key, value);
    }
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
          ? undefined
          : credentials.tokens
            ? {
                tokens: credentials.tokens,
                signInScope: credentials.signInScope,
              }
            : {}),
        ...(scope === "client" || scope === "all"
          ? undefined
          : credentials.clientInformation
            ? { clientInformation: credentials.clientInformation }
            : {}),
        ...(scope === "discovery" || scope === "all"
          ? undefined
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
