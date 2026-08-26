/**
 * Own the remote ACP v1 Streamable HTTP edge.
 *
 * Shared state records route short-lived JSON-RPC messages. Junior's
 * Conversation log remains the source for session replay and Turn output. No
 * request relies on another request reaching the same app process.
 */
import { createHash } from "node:crypto";
import type { User } from "@sentry/junior-plugin-api";
import * as acp from "@agentclientprotocol/sdk";
import { z } from "zod";
import type { AcpErrorContext, ReportAcpError } from "./errors";
import type { AcpConversations } from "./conversations";
import {
  ACP_AUTH_METHOD,
  ACP_AUTH_METHOD_ID,
  beginAcpAuthorization,
  createAcpConnectionCredential,
  expireAcpAuthorization,
  handleAcpAuthorizationResponse,
  hasAcpConnectionCredential,
} from "./auth";
import {
  acceptAcpRequest,
  createAcpConnection,
  deleteAcpConnection,
  openAcpSse,
  readAcpConnection,
  type AcpConnection,
  type AcpPromptStreamOutput,
  type AcpRequestReceipt,
  type AcpStreamRoute,
} from "./transport";
import {
  SESSION_HEADER_METHODS,
  acpConnectionIdSchema,
  acpInboundMessageSchema,
  acpSessionIdSchema,
  authenticateParamsSchema,
  cancelParamsSchema,
  initializeParamsSchema,
  loadSessionParamsSchema,
  newSessionParamsSchema,
  promptParamsSchema,
  type AcpCall,
  type AcpResponse,
  type CancelParams,
  type LoadSessionParams,
  type PromptParams,
  type SessionParams,
} from "./schema";
import type { AcpState } from "./state";

const ACP_CONNECTION_ID_HEADER = "Acp-Connection-Id";
const ACP_SESSION_ID_HEADER = "Acp-Session-Id";
const ACP_CONVERSATION_PREFIX = "local:acp:";
const ACP_EVENT_STREAM_MIME_TYPE = "text/event-stream";
const ACP_JSON_MIME_TYPE = "application/json";
const MAX_PROMPT_TEXT_LENGTH = 32_000;

/** Dependencies for the serverless-safe remote ACP HTTP handler. */
type AcpHttpHandlerOptions = {
  browserAuth?: { baseURL?: string };
  conversations: AcpConversations;
  onError?: ReportAcpError;
  state: AcpState;
  version: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function authenticatedAcpUser(connection: AcpConnection): User | undefined {
  return connection.user;
}

function supportsUrlElicitation(params: unknown): boolean {
  const parsed = initializeParamsSchema.safeParse(params);
  if (!parsed.success) return false;
  const elicitation = parsed.data.clientCapabilities?.elicitation;
  return isRecord(elicitation) && isRecord(elicitation.url);
}

function parseParams<T>(schema: z.ZodType<T>, params: unknown): T {
  const parsed = schema.safeParse(params);
  if (parsed.success) return parsed.data;
  const firstPath = parsed.error.issues[0]?.path[0];
  throw acp.RequestError.invalidParams({
    field:
      typeof firstPath === "string" || typeof firstPath === "number"
        ? String(firstPath)
        : "params",
  });
}

/** Reject client MCP servers because Junior does not use the client workspace. */
function rejectUnsupportedMcpServers(mcpServers: readonly unknown[]): void {
  if (mcpServers.length > 0) {
    throw acp.RequestError.invalidParams(
      { field: "mcpServers" },
      "Junior does not accept client MCP servers",
    );
  }
}

function resourceLinkText(
  block: Extract<PromptParams["prompt"][number], { type: "resource_link" }>,
): string {
  return [
    "Resource link:",
    `Name: ${block.name}`,
    `URI: ${block.uri}`,
    ...(block.title ? [`Title: ${block.title}`] : []),
    ...(block.description ? [`Description: ${block.description}`] : []),
    ...(block.mimeType ? [`MIME type: ${block.mimeType}`] : []),
    ...(block.size !== undefined && block.size !== null
      ? [`Size: ${block.size} bytes`]
      : []),
  ].join("\n");
}

/** Convert supported ACP content blocks to one bounded API Turn message. */
function promptText(prompt: PromptParams["prompt"]): string {
  if (prompt.length === 0) {
    throw acp.RequestError.invalidParams(
      { field: "prompt" },
      "Junior accepts one or more text or resource link blocks",
    );
  }
  const blocks: string[] = [];
  for (const block of prompt) {
    if (block.type === "resource_link") {
      blocks.push(resourceLinkText(block));
      continue;
    }
    if (!block.text.trim()) {
      throw acp.RequestError.invalidParams(
        { field: "prompt" },
        "Junior accepts non-empty text blocks only",
      );
    }
    blocks.push(block.text);
  }
  const text = blocks.join("\n");
  if (text.length > MAX_PROMPT_TEXT_LENGTH) {
    throw acp.RequestError.invalidParams(
      { field: "prompt" },
      `Junior accepts at most ${MAX_PROMPT_TEXT_LENGTH} prompt characters`,
    );
  }
  return text;
}

function stableHex(value: string, length = 32): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, child]) => [key, canonicalJson(child)]),
  );
}

/** Preserve the JSON-RPC id type and request payload in durable retry keys. */
function requestKey(call: AcpCall & { id: acp.JsonRpcId }): string {
  const id =
    call.id === null
      ? "null"
      : `${typeof call.id}:${stableHex(String(call.id))}`;
  const payload = JSON.stringify(
    canonicalJson({ method: call.method, params: call.params ?? null }),
  );
  return `${id}:${stableHex(payload)}`;
}

function sessionIdFromCall(call: AcpCall | undefined): string | undefined {
  if (!call) return undefined;
  const schema =
    call.method === acp.methods.agent.session.load
      ? loadSessionParamsSchema
      : call.method === acp.methods.agent.session.prompt
        ? promptParamsSchema
        : call.method === acp.methods.agent.session.cancel
          ? cancelParamsSchema
          : undefined;
  if (!schema) return undefined;
  const parsed = schema.safeParse(call.params);
  return parsed.success ? parsed.data.sessionId : undefined;
}

/** Route session methods only from a canonical header and matching strict params. */
function determineRoute(
  connectionId: string,
  call: AcpCall,
  headerSessionId: string | undefined,
): AcpStreamRoute | Response {
  const paramsSessionId = sessionIdFromCall(call);
  if (SESSION_HEADER_METHODS.has(call.method) && !headerSessionId) {
    return textResponse("Missing Acp-Session-Id", 400);
  }
  if (
    headerSessionId !== undefined &&
    paramsSessionId !== undefined &&
    headerSessionId !== paramsSessionId
  ) {
    return textResponse("Mismatched Acp-Session-Id", 400);
  }
  return {
    connectionId,
    ...(headerSessionId
      ? { sessionId: headerSessionId }
      : paramsSessionId
        ? { sessionId: paramsSessionId }
        : {}),
  };
}

function resultMessage(
  requestId: acp.JsonRpcId,
  result: unknown,
): acp.AnyResponse {
  return { jsonrpc: "2.0", id: requestId, result };
}

function errorMessage(
  requestId: acp.JsonRpcId,
  error: acp.RequestError,
): acp.AnyResponse {
  return {
    jsonrpc: "2.0",
    id: requestId,
    error: error.toErrorResponse(),
  };
}

function textResponse(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/plain" },
  });
}

function jsonResponse(
  value: acp.AnyResponse,
  status: number,
  headers?: HeadersInit,
): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": ACP_JSON_MIME_TYPE, ...headers },
  });
}

function emptyResponse(status: number): Response {
  return new Response(null, { status });
}

/** Create a deterministic private Conversation for one session/new request. */
async function createSession(args: {
  call: AcpCall;
  connection: AcpConnection;
  conversations: AcpConversations;
  requestKey: string;
  user: User;
}): Promise<string> {
  const params = parseParams<SessionParams>(
    newSessionParamsSchema,
    args.call.params,
  );
  rejectUnsupportedMcpServers(params.mcpServers);
  const sessionId = `${ACP_CONVERSATION_PREFIX}${stableHex(
    `${args.connection.nonce}:${args.requestKey}`,
  )}`;
  await args.conversations.create({
    conversationId: sessionId,
    user: args.user,
  });
  return sessionId;
}

/** Accept one prompt into the existing durable Conversation mailbox. */
async function acceptPrompt(args: {
  call: AcpCall;
  connection: AcpConnection;
  conversations: AcpConversations;
  requestId: acp.JsonRpcId;
  requestKey: string;
  user: User;
}): Promise<{ output: AcpPromptStreamOutput; sessionId: string }> {
  const params = parseParams<PromptParams>(
    promptParamsSchema,
    args.call.params,
  );
  const admission = await args.conversations.prompt({
    conversationId: params.sessionId,
    idempotencyKey: `${args.connection.nonce}:${args.requestKey}`,
    text: promptText(params.prompt),
    user: args.user,
  });
  if (admission.status === "not_found") {
    throw acp.RequestError.resourceNotFound(params.sessionId);
  }
  if (admission.status === "active") {
    throw acp.RequestError.invalidParams(
      { field: "sessionId" },
      "This ACP session already has an active prompt",
    );
  }
  return {
    output: {
      afterSeq: admission.afterCursor,
      kind: "prompt",
      messageId: admission.messageId,
      requestId: args.requestId,
      turnId: admission.turnId,
    },
    sessionId: params.sessionId,
  };
}

/** Dispatch one connected JSON-RPC request into a durable outbound receipt. */
async function createRequestReceipt(args: {
  call: AcpCall & { id: acp.JsonRpcId };
  connection: AcpConnection;
  conversations: AcpConversations;
  requestKey: string;
  user: User;
}): Promise<AcpRequestReceipt> {
  if (args.call.method === acp.methods.agent.session.new) {
    const sessionId = await createSession(args);
    return {
      outputs: [
        {
          kind: "message",
          message: resultMessage(args.call.id, { sessionId }),
        },
      ],
    };
  }

  if (args.call.method === acp.methods.agent.session.load) {
    const params = parseParams<LoadSessionParams>(
      loadSessionParamsSchema,
      args.call.params,
    );
    rejectUnsupportedMcpServers(params.mcpServers);
    if (
      !(await args.conversations.hasAccess({
        conversationId: params.sessionId,
        user: args.user,
      }))
    ) {
      throw acp.RequestError.resourceNotFound(params.sessionId);
    }
    return {
      sessionId: params.sessionId,
      outputs: [
        { kind: "replay" },
        { kind: "message", message: resultMessage(args.call.id, {}) },
      ],
    };
  }

  if (args.call.method === acp.methods.agent.session.prompt) {
    const prompt = await acceptPrompt({
      ...args,
      requestId: args.call.id,
    });
    return {
      outputs: [prompt.output],
      sessionId: prompt.sessionId,
    };
  }

  throw acp.RequestError.methodNotFound(args.call.method);
}

/** Handle a session/cancel notification through durable Turn control. */
async function handleCancelNotification(args: {
  call: AcpCall;
  conversations: AcpConversations;
  user: User;
}): Promise<void> {
  const params = parseParams<CancelParams>(
    cancelParamsSchema,
    args.call.params,
  );
  const result = await args.conversations.cancel({
    conversationId: params.sessionId,
    user: args.user,
  });
  if (result === "not_found") {
    throw acp.RequestError.resourceNotFound(params.sessionId);
  }
}

/** Require proof that this request controls the named ACP connection. */
async function requireConnection(args: {
  connectionId: string;
  request: Request;
  state: AcpState;
}): Promise<AcpConnection | undefined> {
  const value = await readAcpConnection(args.state, args.connectionId);
  if (
    !value ||
    !hasAcpConnectionCredential(args.request, value.credentialHash)
  ) {
    return undefined;
  }
  return value;
}

function isJsonContentType(contentType: string | null): boolean {
  return (
    contentType?.split(";", 1)[0]?.trim().toLowerCase() === ACP_JSON_MIME_TYPE
  );
}

async function handleInitialize(args: {
  browserAuthAvailable: boolean;
  call: AcpCall;
  request: Request;
  state: AcpState;
  version: string;
}): Promise<Response> {
  const requestId = args.call.id;
  if (requestId === undefined) {
    return textResponse("Initialize request must include an ID", 400);
  }
  try {
    parseParams(initializeParamsSchema, args.call.params);
    if (!supportsUrlElicitation(args.call.params)) {
      throw acp.RequestError.invalidParams(
        { field: "clientCapabilities.elicitation.url" },
        "Remote Junior authentication requires URL elicitation support",
      );
    }
    const credential = createAcpConnectionCredential(args.request);
    const result = {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: {
          image: false,
          audio: false,
          embeddedContext: false,
        },
      },
      authMethods: args.browserAuthAvailable ? [ACP_AUTH_METHOD] : [],
      agentInfo: { name: "junior", version: args.version },
    } satisfies acp.InitializeResponse;
    const connection = await createAcpConnection(
      args.state,
      credential.credentialHash,
    );
    return jsonResponse(resultMessage(requestId, result), 200, {
      [ACP_CONNECTION_ID_HEADER]: connection.connectionId,
      "Set-Cookie": credential.cookie,
    });
  } catch (error) {
    if (!(error instanceof acp.RequestError)) throw error;
    return jsonResponse(errorMessage(requestId, error), 200);
  }
}

async function handleConnectedPost(args: {
  authenticated?: User;
  call: AcpCall;
  connection: AcpConnection;
  connectionId: string;
  options: AcpHttpHandlerOptions;
  request: Request;
  route: AcpStreamRoute;
  state: AcpState;
}): Promise<Response> {
  const requestId = args.call.id;
  if (requestId === undefined) {
    if (
      args.authenticated &&
      args.call.method === acp.methods.agent.session.cancel
    ) {
      try {
        await handleCancelNotification({
          call: args.call,
          conversations: args.options.conversations,
          user: args.authenticated,
        });
      } catch (error) {
        if (!(error instanceof acp.RequestError)) throw error;
      }
    }
    return emptyResponse(202);
  }

  const identifiedCall = { ...args.call, id: requestId };
  const identifiedRequestKey = requestKey(identifiedCall);
  const acceptance: Parameters<typeof acceptAcpRequest>[0] = {
    connectionId: args.connectionId,
    requestKey: identifiedRequestKey,
    state: args.state,
    createReceipt: async (): Promise<AcpRequestReceipt> => {
      try {
        if (identifiedCall.method === acp.methods.agent.authenticate) {
          const params = parseParams(
            authenticateParamsSchema,
            identifiedCall.params,
          );
          if (params.methodId !== ACP_AUTH_METHOD_ID) {
            throw acp.RequestError.invalidParams(
              { field: "methodId" },
              "Junior did not advertise this authentication method",
            );
          }
          if (args.authenticated) {
            return {
              outputs: [
                {
                  kind: "message",
                  message: resultMessage(requestId, {}),
                },
              ],
            };
          }
          if (!args.options.browserAuth) {
            throw acp.RequestError.internalError(
              undefined,
              "Junior ACP authentication requires an enabled dashboard",
            );
          }
          return await beginAcpAuthorization({
            baseURL: args.options.browserAuth.baseURL,
            connectionId: args.connectionId,
            credentialHash: args.connection.credentialHash,
            request: args.request,
            requestId,
            requestKey: identifiedRequestKey,
            state: args.state,
          });
        }
        if (!args.authenticated) {
          throw acp.RequestError.authRequired();
        }
        return await createRequestReceipt({
          call: identifiedCall,
          connection: args.connection,
          conversations: args.options.conversations,
          requestKey: identifiedRequestKey,
          user: args.authenticated,
        });
      } catch (error) {
        if (!(error instanceof acp.RequestError)) throw error;
        const receipt: AcpRequestReceipt = {
          outputs: [
            {
              kind: "message",
              message: errorMessage(requestId, error),
            },
          ],
        };
        if (args.route.sessionId) receipt.sessionId = args.route.sessionId;
        return receipt;
      }
    },
  };
  if (identifiedCall.method === acp.methods.agent.session.prompt) {
    acceptance.reserveRoute = args.route;
  }
  const status = await acceptAcpRequest(acceptance);
  if (status === "busy") {
    return textResponse("ACP request is already being accepted", 503);
  }
  if (status === "expired") {
    return textResponse("Unknown Acp-Connection-Id", 404);
  }
  if (status === "full") {
    return textResponse("ACP stream has too much undelivered output", 503);
  }
  return emptyResponse(202);
}

async function handleConnectedResponse(args: {
  connectionId: string;
  response: AcpResponse;
  state: AcpState;
}): Promise<Response> {
  await handleAcpAuthorizationResponse({
    connectionId: args.connectionId,
    response: args.response as acp.AnyResponse,
    state: args.state,
  });
  return emptyResponse(202);
}

/** Create a serverless-safe remote ACP v1 HTTP handler. */
export function createAcpHttpHandler(
  options: AcpHttpHandlerOptions,
): (request: Request) => Promise<Response> {
  const state = options.state;

  return async (request) => {
    let authenticated: User | undefined;
    let call: AcpCall | undefined;
    let connectionId: string | undefined;
    let sessionId: string | undefined;
    try {
      if (request.headers.has("Authorization")) {
        return new Response("Unauthorized", { status: 401 });
      }

      const connectionHeader = request.headers.get(ACP_CONNECTION_ID_HEADER);
      if (connectionHeader !== null) {
        const parsed = acpConnectionIdSchema.safeParse(connectionHeader);
        if (!parsed.success) {
          return textResponse("Invalid Acp-Connection-Id", 400);
        }
        connectionId = parsed.data;
      }
      const sessionHeader = request.headers.get(ACP_SESSION_ID_HEADER);
      if (sessionHeader !== null) {
        const parsed = acpSessionIdSchema.safeParse(sessionHeader);
        if (!parsed.success) {
          return textResponse("Invalid Acp-Session-Id", 400);
        }
        sessionId = parsed.data;
      }

      if (request.method === "POST") {
        if (!isJsonContentType(request.headers.get("Content-Type"))) {
          return textResponse("Unsupported Media Type", 415);
        }
        let value: unknown;
        try {
          value = await request.json();
        } catch {
          return textResponse("Invalid JSON", 400);
        }
        if (Array.isArray(value)) {
          return textResponse(
            "Batch JSON-RPC requests are not implemented",
            501,
          );
        }
        const parsedMessage = acpInboundMessageSchema.safeParse(value);
        if (!parsedMessage.success) {
          return textResponse("Invalid JSON-RPC message", 400);
        }
        const message = parsedMessage.data;

        if (
          "method" in message &&
          message.method === acp.methods.agent.initialize
        ) {
          call = message;
          if (connectionId) {
            return textResponse(
              "Initialize not allowed on existing connection",
              400,
            );
          }
          return await handleInitialize({
            browserAuthAvailable: options.browserAuth !== undefined,
            call,
            request,
            state,
            version: options.version,
          });
        }
        if (!connectionId) {
          return textResponse("Missing Acp-Connection-Id", 400);
        }
        const connection = await requireConnection({
          connectionId,
          request,
          state,
        });
        if (!connection) {
          return textResponse("Unauthorized", 401);
        }
        authenticated = authenticatedAcpUser(connection);
        if (!("method" in message)) {
          return await handleConnectedResponse({
            connectionId,
            response: message,
            state,
          });
        }
        call = message;
        const route = determineRoute(connectionId, call, sessionId);
        if (route instanceof Response) return route;
        return await handleConnectedPost({
          authenticated,
          call,
          connection,
          connectionId,
          options,
          request,
          route,
          state,
        });
      }

      if (!connectionId) {
        return textResponse("Missing Acp-Connection-Id", 400);
      }
      const connection = await requireConnection({
        connectionId,
        request,
        state,
      });
      if (!connection) {
        return textResponse("Unauthorized", 401);
      }
      authenticated = authenticatedAcpUser(connection);

      if (request.method === "GET") {
        if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
          return textResponse("WebSocket upgrade is not implemented", 426);
        }
        const accept = request.headers.get("Accept")?.toLowerCase();
        if (!accept?.includes(ACP_EVENT_STREAM_MIME_TYPE)) {
          return textResponse("Not Acceptable", 406);
        }
        const route: AcpStreamRoute = { connectionId };
        if (sessionId) route.sessionId = sessionId;
        const stream: Parameters<typeof openAcpSse>[0] = {
          conversations: options.conversations,
          onError: options.onError,
          requestSignal: request.signal,
          route,
          state,
        };
        if (!sessionId) {
          stream.maintain = async () => {
            await expireAcpAuthorization({
              connectionId: route.connectionId,
              state,
            });
          };
        }
        if (authenticated) stream.userId = authenticated.id;
        return await openAcpSse(stream);
      }

      if (request.method === "DELETE") {
        await deleteAcpConnection(state, connectionId);
        return emptyResponse(202);
      }

      return textResponse("Method Not Allowed", 405);
    } catch (error) {
      const conversationId = sessionIdFromCall(call) ?? sessionId;
      const context: AcpErrorContext = {};
      if (authenticated) context.userId = authenticated.id;
      if (connectionId) context.connectionId = connectionId;
      if (conversationId) context.conversationId = conversationId;
      options.onError?.(error, "acp.transport.exception", context);
      return textResponse("ACP transport failed", 500);
    }
  };
}
