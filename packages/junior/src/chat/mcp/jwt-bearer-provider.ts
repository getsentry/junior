/**
 * Non-interactive MCP auth for bot plugins.
 *
 * When a manifest declares `mcp.auth`, this provider signs a short-lived RFC 7523 jwt-bearer
 * assertion with a plugin-held private key and the SDK exchanges it at the server token endpoint.
 * No user, no browser redirect; expired access tokens re-mint automatically on the next 401.
 * The absent redirectUrl is what routes the SDK into its non-interactive token flow, the
 * `oauth-id-jag+jwt` typ header is what identity-assertion servers require, and the placeholder
 * redirect_uri exists only because dynamic client registration rejects an empty list.
 */
import { randomUUID } from "node:crypto";
import type {
  OAuthClientProvider,
  OAuthDiscoveryState,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { importPKCS8, SignJWT } from "jose";
import type { PluginMcpConfig } from "@sentry/junior-plugin-api";

const JWT_BEARER_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:jwt-bearer";
const ALGORITHM = "RS256";

function nonInteractive(): never {
  throw new Error("jwt-bearer MCP auth is non-interactive");
}

/** Build the OAuth client provider that signs jwt-bearer assertions for one bot MCP plugin. */
export function createJwtBearerMcpClientProvider(
  subject: string,
  mcpUrl: string,
  auth: NonNullable<PluginMcpConfig["auth"]>,
): OAuthClientProvider {
  let discovery: OAuthDiscoveryState | undefined;
  let clientInfo: OAuthClientInformationMixed | undefined;
  let tokens: OAuthTokens | undefined;

  return {
    redirectUrl: undefined,
    clientMetadata: {
      client_name: subject,
      redirect_uris: ["http://localhost"],
      token_endpoint_auth_method: "none",
    },
    discoveryState: () => discovery,
    saveDiscoveryState: (state) => {
      discovery = state;
    },
    clientInformation: () => clientInfo,
    saveClientInformation: (info) => {
      clientInfo = info;
    },
    tokens: () => tokens,
    saveTokens: (next) => {
      tokens = next;
    },
    redirectToAuthorization: nonInteractive,
    saveCodeVerifier: nonInteractive,
    codeVerifier: nonInteractive,
    prepareTokenRequest: async () => {
      if (!discovery) {
        throw new Error("jwt-bearer token request requires discovered server metadata");
      }
      const privateKeyPem = process.env[auth.privateKeyEnv];
      if (!privateKeyPem) {
        throw new Error(
          `jwt-bearer MCP auth env var ${auth.privateKeyEnv} is unset`,
        );
      }
      const assertion = await new SignJWT({
        client_id: clientInfo?.client_id,
        resource: mcpUrl,
      })
        .setProtectedHeader({
          alg: ALGORITHM,
          kid: auth.keyId,
          typ: "oauth-id-jag+jwt",
        })
        .setIssuer(auth.issuer)
        .setSubject(subject)
        .setAudience(
          discovery.authorizationServerMetadata?.issuer ??
            discovery.authorizationServerUrl,
        )
        .setIssuedAt()
        .setExpirationTime("5m")
        .setJti(randomUUID())
        .sign(await importPKCS8(privateKeyPem, ALGORITHM));
      return new URLSearchParams({
        grant_type: JWT_BEARER_GRANT_TYPE,
        assertion,
      });
    },
  };
}
