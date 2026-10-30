/**
 * Own the remote MCP HTTP edge: discovery metadata, OAuth endpoints, and the
 * Streamable HTTP route at `/api/mcp`.
 *
 * The app mounts this handler only when the dashboard requires Google
 * sign-in (`dashboardRequiresSignIn`), because consent needs a signed-in
 * Junior user. A dashboard without required sign-in serves a local viewer.
 */
import { Hono } from "hono";
import { handleMcpAuthorize } from "./authorization";
import { authenticateMcpAccessToken } from "./grants";
import {
  MCP_AUTHORIZATION_SERVER_METADATA_PATH,
  MCP_AUTHORIZE_PATH,
  MCP_PATH,
  MCP_TOKEN_PATH,
  MCP_RESOURCE_METADATA_PATH,
  authorizationServerMetadata,
  protectedResourceMetadata,
  resolveMcpUrls,
  type McpUrls,
} from "./metadata";
import { handleMcpServerRequest } from "./server";
import type { McpState } from "./state";
import { handleMcpToken } from "./token";

/** Host paths that the app forwards to the MCP handler. */
export const MCP_ROUTE_PATHS = [
  MCP_PATH,
  MCP_RESOURCE_METADATA_PATH,
  MCP_AUTHORIZATION_SERVER_METADATA_PATH,
  MCP_AUTHORIZE_PATH,
  MCP_TOKEN_PATH,
];

/** Settings for the MCP HTTP handler. */
type McpHttpHandlerOptions = {
  /** Configured public origin. Unset allows only loopback request origins. */
  baseURL?: string;
  state: McpState;
};

/**
 * Return the RFC 6750 challenge that points clients to resource metadata.
 * A request that sent a token also gets `invalid_token`.
 */
function unauthorized(urls: McpUrls, sentToken: boolean): Response {
  const error = sentToken ? 'error="invalid_token", ' : "";
  return new Response(null, {
    status: 401,
    headers: {
      "cache-control": "no-store",
      "www-authenticate": `Bearer ${error}resource_metadata="${urls.resourceMetadata}"`,
    },
  });
}

function bearerToken(request: Request): string | undefined {
  const match = request.headers
    .get("authorization")
    ?.match(/^Bearer\s+(\S+)$/i);
  return match?.[1];
}

/** Create the fetch handler for every path in `MCP_ROUTE_PATHS`. */
export function createMcpHttpHandler(
  options: McpHttpHandlerOptions,
): (request: Request) => Promise<Response> {
  const app = new Hono();
  const urls = (request: Request) => resolveMcpUrls(request, options.baseURL);

  app.get(MCP_RESOURCE_METADATA_PATH, (c) =>
    Response.json(protectedResourceMetadata(urls(c.req.raw))),
  );
  app.get(MCP_AUTHORIZATION_SERVER_METADATA_PATH, (c) =>
    Response.json(authorizationServerMetadata(urls(c.req.raw))),
  );
  app.get(MCP_AUTHORIZE_PATH, (c) =>
    handleMcpAuthorize({
      request: c.req.raw,
      state: options.state,
      urls: urls(c.req.raw),
    }),
  );
  app.post(MCP_TOKEN_PATH, (c) =>
    handleMcpToken({ request: c.req.raw, state: options.state }),
  );
  // Only MCP access tokens for this exact resource pass. Personal tokens and
  // dashboard sessions do not, because MCP grants are a separate consent.
  app.on(["GET", "POST", "DELETE"], MCP_PATH, async (c) => {
    const requestUrls = urls(c.req.raw);
    const token = bearerToken(c.req.raw);
    const user = token
      ? await authenticateMcpAccessToken({
          resource: requestUrls.resource,
          state: options.state,
          token,
        })
      : undefined;
    if (!user) return unauthorized(requestUrls, token !== undefined);
    // The stateless transport has no session to stream or delete.
    if (c.req.method !== "POST") {
      return new Response(null, { status: 405, headers: { allow: "POST" } });
    }
    return await handleMcpServerRequest(c.req.raw, user);
  });

  return async (request) => await app.fetch(request);
}
