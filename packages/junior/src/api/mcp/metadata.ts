/**
 * Own the MCP OAuth paths, scope, and discovery documents.
 *
 * Every URL comes from the trusted public origin of the app. The documents
 * advertise Client ID Metadata Documents and no client registration endpoint.
 */
import { resolvePublicOrigin } from "@/api/public-origin";

export const MCP_PATH = "/api/mcp";
export const MCP_SCOPE = "conversations:read";
export const MCP_RESOURCE_METADATA_PATH =
  "/.well-known/oauth-protected-resource/api/mcp";
export const MCP_AUTHORIZATION_SERVER_METADATA_PATH =
  "/.well-known/oauth-authorization-server";
export const MCP_AUTHORIZE_PATH = "/api/mcp/oauth/authorize";
export const MCP_TOKEN_PATH = "/api/mcp/oauth/token";
/** Dashboard-authenticated consent page for one pending authorization. */
export const MCP_CONSENT_PATH = "/_junior/mcp/authorize/:requestId";

/** Absolute MCP and OAuth URLs for one public origin. */
export interface McpUrls {
  authorize: string;
  /** RFC 8414 issuer. It is the origin, without a trailing slash. */
  issuer: string;
  /** RFC 8707 resource indicator. Tokens are bound to this exact value. */
  resource: string;
  resourceMetadata: string;
  token: string;
  consent(requestId: string): string;
}

/** Build the MCP and OAuth URLs from the trusted public origin. */
function mcpUrls(origin: URL): McpUrls {
  const url = (path: string) => new URL(path, origin).toString();
  return {
    authorize: url(MCP_AUTHORIZE_PATH),
    issuer: origin.origin,
    resource: url(MCP_PATH),
    resourceMetadata: url(MCP_RESOURCE_METADATA_PATH),
    token: url(MCP_TOKEN_PATH),
    consent: (requestId) =>
      url(
        MCP_CONSENT_PATH.replace(":requestId", encodeURIComponent(requestId)),
      ),
  };
}

/** Resolve the MCP URLs for this request from the trusted public origin. */
export function resolveMcpUrls(request: Request, baseURL?: string): McpUrls {
  const origin = resolvePublicOrigin(request, baseURL);
  if (!origin) {
    throw new Error("Junior MCP requires a configured public base URL");
  }
  return mcpUrls(origin);
}

/** RFC 9728 protected resource metadata for `/api/mcp`. */
export function protectedResourceMetadata(urls: McpUrls) {
  return {
    resource: urls.resource,
    authorization_servers: [urls.issuer],
    bearer_methods_supported: ["header"],
    scopes_supported: [MCP_SCOPE],
  };
}

/** RFC 8414 authorization server metadata. CIMD is the only client model. */
export function authorizationServerMetadata(urls: McpUrls) {
  return {
    issuer: urls.issuer,
    authorization_endpoint: urls.authorize,
    token_endpoint: urls.token,
    scopes_supported: [MCP_SCOPE],
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    authorization_response_iss_parameter_supported: true,
    client_id_metadata_document_supported: true,
  };
}
