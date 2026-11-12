/**
 * Own the remote MCP HTTP edge: discovery metadata, OAuth endpoints, and the
 * Streamable HTTP route at `/api/mcp`.
 */
import { Hono } from "hono";
import { resolveViewerUser } from "@/chat/plugins/viewer";
import type { AttachmentStorage } from "@/chat/attachments/storage";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";
import { isAllowedSignInEmail } from "@/chat/sign-in/allowlist";
import { handleMcpAuthorize } from "./oauth/authorization";
import { authenticateMcpAccessToken } from "./oauth/grants";
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
} from "./oauth/metadata";
import { MCP_ALL_SCOPES } from "./oauth/scopes";
import { handleMcpServerRequest } from "./server";
import type { McpState } from "./oauth/state";
import { handleMcpToken, mcpTokenBodyLimit } from "./oauth/token";

/** Host paths that the app forwards to the MCP handler. */
export const MCP_ROUTE_PATHS = [
  MCP_PATH,
  MCP_RESOURCE_METADATA_PATH,
  MCP_AUTHORIZATION_SERVER_METADATA_PATH,
  MCP_AUTHORIZE_PATH,
  MCP_TOKEN_PATH,
];

type McpHttpHandlerOptions = {
  /** The app's `allowedDomains`. */
  allowedDomains: readonly string[];
  /** Attachment storage for messages that MCP clients send. */
  attachmentStorage: AttachmentStorage;
  /** Configured public origin. Unset allows only loopback request origins. */
  baseURL?: string;
  /** Conversation work queue. Stopping a Turn clears its queued work. */
  queue: ConversationWorkQueue;
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
      "www-authenticate": `Bearer ${error}resource_metadata="${urls.resourceMetadata}", scope="${MCP_ALL_SCOPES}"`,
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
): (request: Request) => Response | Promise<Response> {
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
  app.post(MCP_TOKEN_PATH, mcpTokenBodyLimit, (c) =>
    handleMcpToken({ request: c.req.raw, state: options.state }),
  );
  // Personal tokens and dashboard sessions do not pass, because an MCP grant
  // is a separate consent.
  app.on(["GET", "POST", "DELETE"], MCP_PATH, async (c) => {
    const requestUrls = urls(c.req.raw);
    const token = bearerToken(c.req.raw);
    const grant = token
      ? await authenticateMcpAccessToken({
          resource: requestUrls.resource,
          state: options.state,
          token,
        })
      : undefined;
    const user =
      grant && isAllowedSignInEmail(grant.email, options.allowedDomains)
        ? await resolveViewerUser(grant.email)
        : undefined;
    if (!grant || !user) return unauthorized(requestUrls, token !== undefined);
    // The stateless transport has no session to stream or delete.
    if (c.req.method !== "POST") {
      return new Response(null, { status: 405, headers: { allow: "POST" } });
    }
    return await handleMcpServerRequest(c.req.raw, {
      attachmentStorage: options.attachmentStorage,
      queue: options.queue,
      scopes: grant.scopes,
      user,
    });
  });

  return app.fetch;
}
