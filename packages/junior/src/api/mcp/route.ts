/**
 * Own the remote MCP HTTP edge: discovery metadata, OAuth endpoints, and the
 * Streamable HTTP route at `/api/mcp`.
 *
 * The app mounts this handler only when the dashboard and its Google sign-in
 * are configured, because consent needs a signed-in Junior user.
 */
import { Hono } from "hono";
import { resolvePublicOrigin } from "@/api/public-origin";
import {
  MCP_AUTHORIZATION_SERVER_METADATA_PATH,
  MCP_PATH,
  MCP_RESOURCE_METADATA_PATH,
  authorizationServerMetadata,
  mcpUrls,
  protectedResourceMetadata,
  type McpUrls,
} from "./metadata";

/** Host paths that the app forwards to the MCP handler. */
export const MCP_ROUTE_PATHS = [
  MCP_PATH,
  MCP_RESOURCE_METADATA_PATH,
  MCP_AUTHORIZATION_SERVER_METADATA_PATH,
];

/** Settings for the MCP HTTP handler. */
type McpHttpHandlerOptions = {
  /** Configured public origin. Unset allows only loopback request origins. */
  baseURL?: string;
};

/** Resolve the MCP URLs for this request from the trusted public origin. */
function resolveMcpUrls(request: Request, baseURL?: string): McpUrls {
  const origin = resolvePublicOrigin(request, baseURL);
  if (!origin) {
    throw new Error("Junior MCP requires a configured public base URL");
  }
  return mcpUrls(origin);
}

/** Return the RFC 6750 challenge that points clients to resource metadata. */
function unauthorized(urls: McpUrls): Response {
  return Response.json(
    { error: "invalid_token" },
    {
      status: 401,
      headers: {
        "cache-control": "no-store",
        "www-authenticate": `Bearer resource_metadata="${urls.resourceMetadata}"`,
      },
    },
  );
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
  app.on(["GET", "POST", "DELETE"], MCP_PATH, (c) =>
    unauthorized(urls(c.req.raw)),
  );

  return async (request) => await app.fetch(request);
}
