/**
 * Non-interactive MCP auth for bot plugins.
 *
 * When plugin.yaml declares `mcp.auth`, this provider signs a short-lived
 * RFC 7523 jwt-bearer assertion with a plugin-held private key and the SDK
 * exchanges it at the server token endpoint. No user, no browser redirect;
 * expired access tokens re-mint automatically on the next 401.
 */
import { randomUUID } from "node:crypto";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { importPKCS8, SignJWT } from "jose";
import type { PluginMcpAuthConfig } from "@sentry/junior-plugin-api";

const JWT_BEARER_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:jwt-bearer";
const ASSERTION_LIFETIME_SECONDS = 300;

export class JwtBearerMcpClientProvider implements OAuthClientProvider {
  readonly clientMetadata: OAuthClientMetadata;
  private readonly audience: string;
  private readonly resource: string;
  private clientInfo?: OAuthClientInformationMixed;
  private storedTokens?: OAuthTokens;

  constructor(
    mcpUrl: string,
    private readonly auth: PluginMcpAuthConfig,
  ) {
    // The MCP server issues tokens itself, so its issuer is the URL origin.
    this.audience = `${new URL(mcpUrl).origin}/`;
    this.resource = mcpUrl;
    this.clientMetadata = {
      client_name: auth.subject,
      // Never used in this flow, but dynamic registration requires one entry.
      redirect_uris: ["http://localhost"],
      token_endpoint_auth_method: "none",
    };
  }

  // No redirectUrl: the SDK runs the non-interactive token flow instead of
  // the authorization-code redirect flow.
  get redirectUrl(): undefined {
    return undefined;
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return this.clientInfo;
  }

  saveClientInformation(clientInformation: OAuthClientInformationMixed): void {
    this.clientInfo = clientInformation;
  }

  tokens(): OAuthTokens | undefined {
    return this.storedTokens;
  }

  saveTokens(tokens: OAuthTokens): void {
    this.storedTokens = tokens;
  }

  redirectToAuthorization(): void {
    throw new Error("jwt-bearer MCP auth is non-interactive");
  }

  saveCodeVerifier(): void {
    throw new Error("jwt-bearer MCP auth is non-interactive");
  }

  codeVerifier(): string {
    throw new Error("jwt-bearer MCP auth is non-interactive");
  }

  async prepareTokenRequest(): Promise<URLSearchParams> {
    const clientId = this.clientInfo?.client_id;
    if (!clientId) {
      throw new Error(
        "jwt-bearer token request requires a registered client_id",
      );
    }
    const privateKeyPem = process.env[this.auth.privateKeyEnv];
    if (!privateKeyPem) {
      throw new Error(
        `jwt-bearer MCP auth env var ${this.auth.privateKeyEnv} is unset`,
      );
    }
    const algorithm = this.auth.algorithm ?? "RS256";
    const key = await importPKCS8(privateKeyPem, algorithm);
    const now = Math.floor(Date.now() / 1000);
    const assertion = await new SignJWT({
      client_id: clientId,
      resource: this.resource,
    })
      // Identity-assertion servers (fastmcp SEP-990) require this exact typ.
      .setProtectedHeader({
        alg: algorithm,
        kid: this.auth.keyId,
        typ: "oauth-id-jag+jwt",
      })
      .setIssuer(this.auth.issuer)
      .setSubject(this.auth.subject)
      .setAudience(this.audience)
      .setIssuedAt(now)
      .setExpirationTime(now + ASSERTION_LIFETIME_SECONDS)
      .setJti(randomUUID())
      .sign(key);
    return new URLSearchParams({
      grant_type: JWT_BEARER_GRANT_TYPE,
      assertion,
    });
  }
}
