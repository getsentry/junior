/**
 * Own the remote ACP HTTP edge.
 *
 * Every request authenticates one Actor. Connections stay in this app process,
 * and sessions map only to that Actor's private Conversations. This prototype
 * accepts text prompts and durable replay. It does not accept client tools.
 */
import { randomUUID } from "node:crypto";
import type { StateAdapter } from "chat";
import type { User } from "@sentry/junior-plugin-api";
import * as acp from "@agentclientprotocol/sdk";
import { AcpServer } from "@agentclientprotocol/sdk/experimental/server";
import { readConversationAccessFromSql } from "@/api/conversations/access";
import {
  apiTurnIdForMessage,
  appendAndEnqueueApiConversationMessage,
  recordApiConversationActivity,
  webActorFromEmail,
} from "@/chat/api-turns/work";
import type { WebActor } from "@/chat/actor";
import type { ConversationEventStore } from "@/chat/conversations/history";
import { projectConversationMessages } from "@/chat/conversations/message-projection";
import type { ConversationStore } from "@/chat/conversations/store";
import {
  getConversationEventStore,
  getConversationStore,
  getDb,
} from "@/chat/db";
import { resolveViewerUser } from "@/chat/plugins/viewer";
import { logException, withSpan } from "@/chat/logging";
import { sleep } from "@/chat/sleep";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";
import { ensureConversationWake } from "@/chat/task-execution/store";
import type { ApiTurnCancellation } from "@/chat/api-turns/cancellation";
import { authenticatePersonalToken } from "@/personal-tokens/store";
import { JUNIOR_VERSION } from "@/version";

const ACP_CONNECTION_ID_HEADER = "Acp-Connection-Id";
const ACP_CONVERSATION_PREFIX = "local:acp:";
const EVENT_PAGE_SIZE = 50;
const EVENT_POLL_INTERVAL_MS = 25;
const MAX_PROMPT_TEXT_LENGTH = 32_000;

interface AcpRouteOptions {
  cancellation: ApiTurnCancellation;
  conversationStore?: ConversationStore;
  queue: ConversationWorkQueue;
  state?: StateAdapter;
}

interface AuthenticatedAcpActor {
  actor: WebActor;
  user: User;
}

type AcpOperation =
  | "initialize"
  | "session_cancel"
  | "session_load"
  | "session_new"
  | "session_prompt";

function bearerToken(request: Request): string | undefined {
  const authorization = request.headers.get("Authorization");
  const match = authorization?.match(/^Bearer ([^\s]+)$/);
  return match?.[1];
}

/** Resolve one personal token to the Actor and user that own the request. */
async function authenticateRequest(
  request: Request,
): Promise<AuthenticatedAcpActor | undefined> {
  const token = bearerToken(request);
  if (!token) return undefined;
  const email = await authenticatePersonalToken(token);
  if (!email) return undefined;
  const user = await resolveViewerUser(email);
  if (!user) return undefined;
  return {
    actor: webActorFromEmail(
      user.email ?? email,
      user.displayName ? { fullName: user.displayName } : undefined,
    ),
    user,
  };
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

/** Require an ACP session that belongs to the authenticated participant. */
async function requireOwnedSession(
  sessionId: string,
  user: User,
): Promise<void> {
  if (!sessionId.startsWith(ACP_CONVERSATION_PREFIX)) {
    throw acp.RequestError.resourceNotFound(sessionId);
  }
  const access = (
    await readConversationAccessFromSql(getDb(), [sessionId], user)
  ).get(sessionId);
  if (!access?.isParticipant) {
    throw acp.RequestError.resourceNotFound(sessionId);
  }
}

/** Convert supported ACP text blocks to one bounded API Turn message. */
function promptText(prompt: readonly acp.ContentBlock[]): string {
  if (prompt.length === 0) {
    throw acp.RequestError.invalidParams(
      { field: "prompt" },
      "Junior accepts one or more text blocks only",
    );
  }
  const blocks: string[] = [];
  for (const block of prompt) {
    if (block.type !== "text") {
      throw acp.RequestError.invalidParams(
        { field: "prompt" },
        "Junior accepts one or more text blocks only",
      );
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

/** Preserve the JSON-RPC id type in one connection-scoped mailbox key. */
function requestIdKey(requestId: acp.JsonRpcId): string {
  if (requestId === null) return "null";
  return `${typeof requestId}:${requestId}`;
}

async function latestEventSeq(
  eventStore: ConversationEventStore,
  conversationId: string,
): Promise<number> {
  const page = await eventStore.query(conversationId, { limit: 1 });
  return page.events.at(-1)?.seq ?? 0;
}

/** Replay durable user and assistant Messages in their stored order. */
async function replaySession(
  eventStore: ConversationEventStore,
  sessionId: string,
  client: acp.AgentContext,
): Promise<void> {
  const history = await eventStore.loadMessageHistory(sessionId);
  for (const message of projectConversationMessages(history)) {
    if (message.role === "system") continue;
    await client.notify(acp.methods.client.session.update, {
      sessionId,
      update: {
        sessionUpdate:
          message.role === "user"
            ? "user_message_chunk"
            : "agent_message_chunk",
        content: { type: "text", text: message.text },
        messageId: message.id,
      },
    });
  }
}

/** Stream durable assistant Messages until the matching Turn ends or fails. */
async function waitForTurn(args: {
  afterSeq: number;
  cancellation: ApiTurnCancellation;
  cancellationSignal: AbortSignal;
  client: acp.AgentContext;
  eventStore: ConversationEventStore;
  sessionId: string;
  signal: AbortSignal;
  turnId: string;
}): Promise<acp.PromptResponse> {
  let cursor = args.afterSeq;
  const assistantPrefix = `${args.turnId}:assistant:`;
  const sentMessageIds = new Set<string>();

  while (true) {
    if (args.signal.aborted) {
      throw acp.RequestError.requestCancelled();
    }
    const page = await args.eventStore.query(args.sessionId, {
      afterSeq: cursor,
      limit: EVENT_PAGE_SIZE,
      types: ["message", "turn_completed", "turn_failed"],
    });
    if (page.events.length === 0) {
      try {
        await sleep(EVENT_POLL_INTERVAL_MS, args.signal);
      } catch (error) {
        if (args.signal.aborted) {
          throw acp.RequestError.requestCancelled();
        }
        throw error;
      }
      continue;
    }

    for (const event of page.events) {
      cursor = event.seq;
      const data = event.data;
      if (
        data.type === "message" &&
        data.role === "assistant" &&
        data.messageId.startsWith(assistantPrefix) &&
        !sentMessageIds.has(data.messageId)
      ) {
        sentMessageIds.add(data.messageId);
        await args.client.notify(acp.methods.client.session.update, {
          sessionId: args.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: data.text },
            messageId: data.messageId,
          },
        });
        continue;
      }
      if (data.type === "turn_completed" && data.turnId === args.turnId) {
        args.cancellation.finish(args.sessionId, args.cancellationSignal);
        return {
          stopReason: data.outcome === "cancelled" ? "cancelled" : "end_turn",
        };
      }
      if (data.type === "turn_failed" && data.turnId === args.turnId) {
        args.cancellation.finish(args.sessionId, args.cancellationSignal);
        throw acp.RequestError.internalError(
          { failureCode: data.failureCode },
          "Junior Turn failed",
        );
      }
    }
  }
}

/** Trace one protocol operation and capture only unexpected edge failures. */
async function runAcpOperation<T>(
  authenticated: AuthenticatedAcpActor,
  operation: AcpOperation,
  conversationId: string | undefined,
  callback: () => Promise<T> | T,
): Promise<T> {
  const name = `acp.${operation}`;
  return await withSpan(
    name,
    name,
    {
      actorId: authenticated.actor.userId,
      conversationId,
      platform: "acp",
      userId: authenticated.actor.userId,
    },
    async () => {
      try {
        return await callback();
      } catch (error) {
        if (!(error instanceof acp.RequestError)) {
          logException(error, `${name}.failed`);
        }
        throw error;
      }
    },
  );
}

/** Build the ACP Agent whose session handlers run as one authenticated Actor. */
function createActorAgent(
  authenticated: AuthenticatedAcpActor,
  connectionNonce: string,
  options: AcpRouteOptions,
) {
  const conversationStore = options.conversationStore ?? getConversationStore();
  const eventStore = getConversationEventStore();

  return acp
    .agent({ name: "junior" })
    .onRequest(acp.methods.agent.initialize, () =>
      runAcpOperation(authenticated, "initialize", undefined, () => ({
        protocolVersion: acp.PROTOCOL_VERSION,
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: {
            image: false,
            audio: false,
            embeddedContext: false,
          },
        },
        authMethods: [],
        agentInfo: { name: "junior", version: JUNIOR_VERSION },
      })),
    )
    .onRequest(acp.methods.agent.session.new, async (context) => {
      return await runAcpOperation(
        authenticated,
        "session_new",
        undefined,
        async () => {
          rejectUnsupportedMcpServers(context.params.mcpServers);
          const sessionId = `${ACP_CONVERSATION_PREFIX}${randomUUID()}`;
          await recordApiConversationActivity({
            actor: authenticated.actor,
            conversationId: sessionId,
            conversationStore,
            nowMs: Date.now(),
            rootVisibility: "private",
          });
          return { sessionId };
        },
      );
    })
    .onRequest(acp.methods.agent.session.load, async (context) => {
      return await runAcpOperation(
        authenticated,
        "session_load",
        context.params.sessionId,
        async () => {
          rejectUnsupportedMcpServers(context.params.mcpServers);
          await requireOwnedSession(
            context.params.sessionId,
            authenticated.user,
          );
          await replaySession(
            eventStore,
            context.params.sessionId,
            context.client,
          );
          return {};
        },
      );
    })
    .onRequest(acp.methods.agent.session.prompt, async (context) => {
      return await runAcpOperation(
        authenticated,
        "session_prompt",
        context.params.sessionId,
        async () => {
          await requireOwnedSession(
            context.params.sessionId,
            authenticated.user,
          );
          const text = promptText(context.params.prompt);
          const currentSeq = await latestEventSeq(
            eventStore,
            context.params.sessionId,
          );
          const cancellationSignal = options.cancellation.begin(
            context.params.sessionId,
          );
          if (!cancellationSignal) {
            throw acp.RequestError.invalidParams(
              { field: "sessionId" },
              "This ACP session already has an active prompt",
            );
          }
          let accepted: Awaited<
            ReturnType<typeof appendAndEnqueueApiConversationMessage>
          >;
          try {
            accepted = await appendAndEnqueueApiConversationMessage(
              {
                actor: authenticated.actor,
                conversationId: context.params.sessionId,
                idempotencyKey: `${connectionNonce}:${requestIdKey(context.requestId)}`,
                message: text,
              },
              {
                conversationStore,
                queue: options.queue,
                state: options.state,
              },
            );
          } catch (error) {
            options.cancellation.finish(
              context.params.sessionId,
              cancellationSignal,
            );
            throw error;
          }
          // A duplicate request can refer to a Turn that ended before currentSeq.
          const afterSeq = accepted.status === "duplicate" ? 0 : currentSeq;
          return await waitForTurn({
            afterSeq,
            cancellation: options.cancellation,
            cancellationSignal,
            client: context.client,
            eventStore,
            sessionId: context.params.sessionId,
            signal: context.signal,
            turnId: apiTurnIdForMessage(accepted.messageId),
          });
        },
      );
    })
    .onNotification(acp.methods.agent.session.cancel, async (context) => {
      await runAcpOperation(
        authenticated,
        "session_cancel",
        context.params.sessionId,
        async () => {
          await requireOwnedSession(
            context.params.sessionId,
            authenticated.user,
          );
          if (!options.cancellation.cancel(context.params.sessionId)) {
            return;
          }
          const nowMs = Date.now();
          await ensureConversationWake({
            conversationId: context.params.sessionId,
            conversationStore,
            idempotencyKey: `acp-cancel:${context.params.sessionId}:${nowMs}`,
            nowMs,
            queue: options.queue,
            replaceExistingWake: true,
            state: options.state,
          });
        },
      );
    });
}

function isJsonRpcId(value: unknown): value is acp.JsonRpcId {
  return (
    value === null ||
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

/** Reject object-shaped messages that would make the SDK log their raw body. */
async function hasSafeAcpEnvelope(request: Request): Promise<boolean> {
  if (request.method !== "POST") return true;
  let value: unknown;
  try {
    value = await request.clone().json();
  } catch {
    return true;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return true;
  }
  if (!("jsonrpc" in value) || value.jsonrpc !== "2.0") {
    return false;
  }
  if (!("method" in value) || typeof value.method !== "string") {
    return false;
  }
  return !("id" in value) || isJsonRpcId(value.id);
}

/** Return whether an SDK initialization response contains a protocol result. */
async function initializationSucceeded(response: Response): Promise<boolean> {
  try {
    const value: unknown = await response.clone().json();
    return typeof value === "object" && value !== null && "result" in value;
  } catch {
    return false;
  }
}

/** Create one app-scoped remote ACP v1 HTTP handler. */
export function createAcpHttpHandler(
  options: AcpRouteOptions,
): (request: Request) => Promise<Response> {
  const server = new AcpServer({ agent: acp.agent({ name: "junior" }) });
  const connectionActors = new Map<string, string>();

  return async (request) => {
    const authenticated = await authenticateRequest(request);
    if (!authenticated) {
      return new Response("Unauthorized", { status: 401 });
    }

    const connectionId = request.headers.get(ACP_CONNECTION_ID_HEADER);
    const connectionActorId = connectionId
      ? connectionActors.get(connectionId)
      : undefined;
    if (connectionId && connectionActorId === undefined) {
      return new Response("Unknown Acp-Connection-Id", { status: 404 });
    }
    if (
      connectionActorId !== undefined &&
      connectionActorId !== authenticated.actor.userId
    ) {
      return new Response("Unknown Acp-Connection-Id", { status: 404 });
    }
    if (!(await hasSafeAcpEnvelope(request))) {
      return new Response("Invalid JSON-RPC message", { status: 400 });
    }

    const response = await server.handleRequest(request, {
      agent: createActorAgent(authenticated, randomUUID(), options),
    });
    const responseConnectionId = response.headers.get(ACP_CONNECTION_ID_HEADER);
    if (response.ok && responseConnectionId && !connectionId) {
      if (await initializationSucceeded(response)) {
        connectionActors.set(responseConnectionId, authenticated.actor.userId);
      } else {
        await server.handleRequest(
          new Request(request.url, {
            method: "DELETE",
            headers: { [ACP_CONNECTION_ID_HEADER]: responseConnectionId },
          }),
        );
        const headers = new Headers(response.headers);
        headers.delete(ACP_CONNECTION_ID_HEADER);
        return new Response(response.body, {
          headers,
          status: response.status,
          statusText: response.statusText,
        });
      }
    }
    if (request.method === "DELETE" && response.ok && connectionId) {
      connectionActors.delete(connectionId);
    }
    return response;
  };
}
