/**
 * Short-lived ACP transport state.
 *
 * Shared state records replace process-local connection maps and stream
 * buffers. Session history and Turn results remain in the Conversation log.
 */
import { createHash, randomUUID } from "node:crypto";
import * as acp from "@agentclientprotocol/sdk";
import { userSchema, type User } from "@sentry/junior-plugin-api";
import { z } from "zod";
import type { AcpErrorContext, ReportAcpError } from "./errors";
import type { ConversationPort } from "./conversations";
import { sleep } from "./sleep";
import {
  fenceLock,
  MUTATION_LOCK_TTL_MS,
  withLock,
  type AcpLock,
  type AcpState,
} from "./state";

// Transport records can expire because the Conversation log owns durable history.
export const ACP_STATE_TTL_MS = 24 * 60 * 60 * 1000;
const ACP_SSE_LEASE_TTL_MS = 60_000;
const ACP_SSE_LEASE_RENEW_INTERVAL_MS = 20_000;
const EVENT_POLL_INTERVAL_MS = 100;
const LOCK_WAIT_MS = 5_000;
// Bound undelivered transport output without truncating Conversation history.
const MAX_STREAM_ITEMS = 1_024;
const MUTATION_LOCK_OPTIONS = {
  keepAlive: true,
  ttlMs: MUTATION_LOCK_TTL_MS,
  waitMs: LOCK_WAIT_MS,
} as const;
const SSE_KEEP_ALIVE_MS = 15_000;
const SSE_MAINTENANCE_INTERVAL_MS = 1_000;

const jsonRpcIdSchema = z.union([z.string(), z.number().finite(), z.null()]);

const jsonRpcErrorSchema = z
  .object({
    code: z.number().int(),
    data: z.unknown().optional(),
    message: z.string(),
  })
  .strict();

const acpMessageSchema = z.union([
  z
    .object({
      id: jsonRpcIdSchema.optional(),
      jsonrpc: z.literal("2.0"),
      method: z.string().min(1),
      params: z.unknown().optional(),
    })
    .strict(),
  z
    .object({
      id: jsonRpcIdSchema,
      jsonrpc: z.literal("2.0"),
      result: z.unknown(),
    })
    .strict(),
  z
    .object({
      error: jsonRpcErrorSchema,
      id: jsonRpcIdSchema,
      jsonrpc: z.literal("2.0"),
    })
    .strict(),
]);

const acpConnectionSchema = z
  .object({
    credentialHash: z.string().length(64),
    nonce: z.string().min(1),
    user: userSchema.optional(),
  })
  .strict();

const acpStreamRouteSchema = z
  .object({
    connectionId: z.string().min(1),
    sessionId: z.string().min(1).optional(),
  })
  .strict();

const acpPromptStreamOutputSchema = z
  .object({
    afterSeq: z.number().int().nonnegative(),
    kind: z.literal("prompt"),
    messageId: z.string().min(1),
    requestId: jsonRpcIdSchema,
    turnId: z.string().min(1),
  })
  .strict();

const acpStreamOutputSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("message"),
      message: acpMessageSchema,
    })
    .strict(),
  z.object({ kind: z.literal("replay") }).strict(),
  acpPromptStreamOutputSchema,
]);

const storedAcpStreamItemSchema = z
  .object({
    id: z.string().min(1),
    output: acpStreamOutputSchema,
  })
  .strict();

const acpRequestReceiptSchema = z
  .object({
    deliveryKey: z.string().min(1).optional(),
    outputs: z.array(acpStreamOutputSchema),
    sessionId: z.string().min(1).optional(),
  })
  .strict();

const acpStreamCursorSchema = z.object({ itemId: z.string().min(1) }).strict();

export type AcpConnection = z.output<typeof acpConnectionSchema>;
export type AcpStreamRoute = z.output<typeof acpStreamRouteSchema>;

export type AcpPromptStreamOutput = z.output<
  typeof acpPromptStreamOutputSchema
>;
type AcpStreamOutput = z.output<typeof acpStreamOutputSchema>;
type StoredAcpStreamItem = z.output<typeof storedAcpStreamItemSchema>;
export type AcpRequestReceipt = z.output<typeof acpRequestReceiptSchema>;

function stableHex(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

function connectionKey(connectionId: string): string {
  return `junior:acp:v1:connection:${connectionId}`;
}

function receiptKey(connectionId: string, requestKey: string): string {
  return `${connectionKey(connectionId)}:request:${requestKey}`;
}

function receiptLockKey(connectionId: string, requestKey: string): string {
  return `${receiptKey(connectionId, requestKey)}:lock`;
}

function connectionLockKey(connectionId: string): string {
  return `${connectionKey(connectionId)}:lock`;
}

function streamKey(route: AcpStreamRoute): string {
  const suffix = route.sessionId
    ? `session:${stableHex(route.sessionId)}`
    : "connection";
  return `${connectionKey(route.connectionId)}:stream:${suffix}`;
}

function streamListKey(route: AcpStreamRoute): string {
  return `${streamKey(route)}:items`;
}

function streamCursorKey(route: AcpStreamRoute): string {
  return `${streamKey(route)}:cursor`;
}

function streamLockKey(route: AcpStreamRoute): string {
  return `${streamKey(route)}:subscriber`;
}

function streamAppendLockKey(route: AcpStreamRoute): string {
  return `${streamKey(route)}:append`;
}

function requestStreamItemId(requestKey: string, index: number): string {
  return `acp-item:${stableHex(`${requestKey}:${index}`)}`;
}

function parseStreamItem(value: unknown): StoredAcpStreamItem {
  return storedAcpStreamItemSchema.parse(value);
}

function parseReceipt(value: unknown): AcpRequestReceipt {
  return acpRequestReceiptSchema.parse(value);
}

async function readStreamItems(
  state: AcpState,
  route: AcpStreamRoute,
): Promise<StoredAcpStreamItem[]> {
  return (await state.getList(streamListKey(route))).map(parseStreamItem);
}

async function readStreamCursor(
  state: AcpState,
  route: AcpStreamRoute,
): Promise<string | undefined> {
  const value = await state.get(streamCursorKey(route));
  return value === null || value === undefined
    ? undefined
    : acpStreamCursorSchema.parse(value).itemId;
}

async function connectionIsLive(
  state: AcpState,
  connectionId: string,
): Promise<boolean> {
  return Boolean(await readAcpConnection(state, connectionId));
}

/** Create one unauthenticated ACP transport connection. */
export async function createAcpConnection(
  state: AcpState,
  credentialHash: string,
): Promise<{ connection: AcpConnection; connectionId: string }> {
  const connectionId = randomUUID();
  const connection = acpConnectionSchema.parse({
    credentialHash,
    nonce: randomUUID(),
  });
  await state.set(connectionKey(connectionId), connection, ACP_STATE_TTL_MS);
  return { connection, connectionId };
}

/** Read one live ACP transport connection. */
export async function readAcpConnection(
  state: AcpState,
  connectionId: string,
): Promise<AcpConnection | undefined> {
  const value = await state.get(connectionKey(connectionId));
  return value === null || value === undefined
    ? undefined
    : acpConnectionSchema.parse(value);
}

/** Remove one ACP connection so all of its live streams terminate. */
export async function deleteAcpConnection(
  state: AcpState,
  connectionId: string,
): Promise<void> {
  const result = await withLock(
    state,
    connectionLockKey(connectionId),
    async (lock) => {
      await fenceLock(state, lock, MUTATION_LOCK_TTL_MS);
      await state.delete(connectionKey(connectionId));
      await fenceLock(state, lock, MUTATION_LOCK_TTL_MS);
      await state.delete(streamCursorKey({ connectionId }));
    },
    MUTATION_LOCK_OPTIONS,
  );
  if (!result.acquired) {
    throw new Error("Timed out acquiring ACP connection control");
  }
}

/** Bind one live ACP connection to the canonical authorized user. */
export async function bindAcpConnectionUser(args: {
  connectionId: string;
  credentialHash: string;
  state: AcpState;
  user: User;
}): Promise<"completed" | "conflict" | "expired"> {
  const result = await withLock(
    args.state,
    connectionLockKey(args.connectionId),
    async (lock) => {
      const connection = await readAcpConnection(args.state, args.connectionId);
      if (!connection || connection.credentialHash !== args.credentialHash) {
        return "expired" as const;
      }
      if (connection.user && connection.user.id !== args.user.id) {
        return "conflict" as const;
      }
      await fenceLock(args.state, lock, MUTATION_LOCK_TTL_MS);
      await args.state.set(
        connectionKey(args.connectionId),
        acpConnectionSchema.parse({ ...connection, user: args.user }),
        ACP_STATE_TTL_MS,
      );
      return "completed" as const;
    },
    MUTATION_LOCK_OPTIONS,
  );
  if (!result.acquired) {
    throw new Error("Timed out acquiring ACP connection control");
  }
  return result.value;
}

async function prepareStreamAppend(args: {
  id?: string;
  lock: AcpLock;
  route: AcpStreamRoute;
  state: AcpState;
}): Promise<StoredAcpStreamItem[] | string> {
  const existing = await readStreamItems(args.state, args.route);
  const cursor = await readStreamCursor(args.state, args.route);
  const cursorIndex = cursor
    ? existing.findIndex((item) => item.id === cursor)
    : -1;
  if (args.id) {
    const pending = existing.slice(cursorIndex >= 0 ? cursorIndex + 1 : 0);
    const pendingItem = pending.find(
      (item) =>
        item.id === args.id || item.id.startsWith(`${args.id}:delivery:`),
    );
    if (pendingItem) return pendingItem.id;
  }
  if (existing.length < MAX_STREAM_ITEMS) return existing;

  if (cursorIndex !== existing.length - 1) {
    throw new AcpStreamFullError();
  }
  await fenceLock(args.state, args.lock, MUTATION_LOCK_TTL_MS);
  await args.state.delete(streamListKey(args.route));
  await args.state.delete(streamCursorKey(args.route));
  return [];
}

/** Reuse pending output IDs and fence stream capacity before each new delivery. */
async function appendStreamOutputWithLock(args: {
  id: string;
  lock: AcpLock;
  output: AcpStreamOutput;
  route: AcpStreamRoute;
  state: AcpState;
}): Promise<string> {
  const route = acpStreamRouteSchema.parse(args.route);
  const output = acpStreamOutputSchema.parse(args.output);
  const existing = await prepareStreamAppend({
    id: args.id,
    lock: args.lock,
    route,
    state: args.state,
  });
  if (typeof existing === "string") return existing;
  const existingIds = new Set(existing.map((item) => item.id));
  let id = args.id;
  for (let delivery = 1; existingIds.has(id); delivery += 1) {
    id = `${args.id}:delivery:${delivery}`;
  }
  await fenceLock(args.state, args.lock, MUTATION_LOCK_TTL_MS);
  if (output.kind !== "message" && !route.sessionId) {
    throw new Error(`ACP ${output.kind} output requires a session stream`);
  }
  await args.state.appendToList(
    streamListKey(route),
    { id, output } satisfies StoredAcpStreamItem,
    { ttlMs: ACP_STATE_TTL_MS },
  );
  return id;
}

async function appendStreamOutput(args: {
  id: string;
  output: AcpStreamOutput;
  route: AcpStreamRoute;
  state: AcpState;
}): Promise<string> {
  const route = acpStreamRouteSchema.parse(args.route);
  const result = await withLock(
    args.state,
    streamAppendLockKey(route),
    async (lock) => await appendStreamOutputWithLock({ ...args, lock, route }),
    MUTATION_LOCK_OPTIONS,
  );
  if (!result.acquired) {
    throw new Error("Timed out acquiring ACP stream append control");
  }
  return result.value;
}

class AcpStreamFullError extends Error {
  constructor() {
    super("ACP stream has too much undelivered output");
    this.name = "AcpStreamFullError";
  }
}

type EmitAcpMessage = (message: acp.AnyMessage) => Promise<boolean>;

/** Replay durable Conversation Messages as ACP session updates. */
async function streamSessionReplay(args: {
  conversations: ConversationPort;
  emit: EmitAcpMessage;
  sessionId: string;
  signal: AbortSignal;
}): Promise<boolean> {
  const messages = await args.conversations.readMessages(args.sessionId);
  for (const message of messages) {
    if (args.signal.aborted) return false;
    const emitted = await args.emit({
      jsonrpc: "2.0",
      method: acp.methods.client.session.update,
      params: {
        sessionId: args.sessionId,
        update: {
          sessionUpdate:
            message.role === "user"
              ? "user_message_chunk"
              : "agent_message_chunk",
          content: { type: "text", text: message.text },
          messageId: message.id,
        },
      },
    });
    if (!emitted) return false;
  }
  return true;
}

/** Queue one request receipt on its connection or session stream. */
async function queueReceipt(args: {
  append?: typeof appendStreamOutput;
  connectionId: string;
  receipt: AcpRequestReceipt;
  requestKey: string;
  state: AcpState;
}): Promise<void> {
  const receipt = parseReceipt(args.receipt);
  const deliveryKey = receipt.deliveryKey ?? args.requestKey;
  const append = args.append ?? appendStreamOutput;
  const route: AcpStreamRoute = { connectionId: args.connectionId };
  if (receipt.sessionId) route.sessionId = receipt.sessionId;
  for (const [index, output] of receipt.outputs.entries()) {
    const id = requestStreamItemId(deliveryKey, index);
    await append({
      id,
      output,
      route,
      state: args.state,
    });
  }
}

/** Replace one pending request receipt and queue its final output once. */
export async function completeAcpRequest(args: {
  connectionId: string;
  receipt: AcpRequestReceipt;
  requestKey: string;
  state: AcpState;
}): Promise<"completed" | "expired" | "full"> {
  try {
    const result = await withLock(
      args.state,
      receiptLockKey(args.connectionId, args.requestKey),
      async (lock) => {
        if (!(await readAcpConnection(args.state, args.connectionId))) {
          return "expired" as const;
        }
        const receipt = parseReceipt(args.receipt);
        await fenceLock(args.state, lock, MUTATION_LOCK_TTL_MS);
        await args.state.set(
          receiptKey(args.connectionId, args.requestKey),
          receipt,
          ACP_STATE_TTL_MS,
        );
        await fenceLock(args.state, lock, MUTATION_LOCK_TTL_MS);
        await queueReceipt({
          connectionId: args.connectionId,
          receipt,
          requestKey: args.requestKey,
          state: args.state,
        });
        return "completed" as const;
      },
      MUTATION_LOCK_OPTIONS,
    );
    if (!result.acquired) {
      throw new Error("Timed out acquiring ACP request completion control");
    }
    return result.value;
  } catch (error) {
    if (error instanceof AcpStreamFullError) return "full";
    throw error;
  }
}

/** Store a receipt once and reserve output before side-effecting creation. */
export async function acceptAcpRequest(args: {
  connectionId: string;
  createReceipt: () => Promise<AcpRequestReceipt>;
  reserveRoute?: AcpStreamRoute;
  requestKey: string;
  state: AcpState;
}): Promise<"accepted" | "busy" | "expired" | "full"> {
  try {
    const result = await withLock(
      args.state,
      receiptLockKey(args.connectionId, args.requestKey),
      async (lock) => {
        if (!(await readAcpConnection(args.state, args.connectionId))) {
          return "expired" as const;
        }
        const stored = await args.state.get(
          receiptKey(args.connectionId, args.requestKey),
        );
        const receipt =
          stored === null || stored === undefined
            ? undefined
            : parseReceipt(stored);
        if (!receipt) {
          const createAndQueue = async (append?: typeof appendStreamOutput) => {
            const created = parseReceipt(await args.createReceipt());
            await fenceLock(args.state, lock, MUTATION_LOCK_TTL_MS);
            await args.state.set(
              receiptKey(args.connectionId, args.requestKey),
              created,
              ACP_STATE_TTL_MS,
            );
            await fenceLock(args.state, lock, MUTATION_LOCK_TTL_MS);
            const queue: Parameters<typeof queueReceipt>[0] = {
              connectionId: args.connectionId,
              receipt: created,
              requestKey: args.requestKey,
              state: args.state,
            };
            if (append) queue.append = append;
            await queueReceipt(queue);
          };
          if (!args.reserveRoute) {
            if (!(await readAcpConnection(args.state, args.connectionId))) {
              return "expired" as const;
            }
            await createAndQueue();
            return "accepted" as const;
          }
          const route = acpStreamRouteSchema.parse(args.reserveRoute);
          const stream = await withLock(
            args.state,
            streamAppendLockKey(route),
            async (streamLock) => {
              await prepareStreamAppend({
                lock: streamLock,
                route,
                state: args.state,
              });
              if (!(await readAcpConnection(args.state, args.connectionId))) {
                return "expired" as const;
              }
              await createAndQueue(async (input) => {
                if (
                  streamAppendLockKey(input.route) !==
                  streamAppendLockKey(route)
                ) {
                  throw new Error("Reserved ACP output changed streams");
                }
                return await appendStreamOutputWithLock({
                  ...input,
                  lock: streamLock,
                });
              });
              return "accepted" as const;
            },
            MUTATION_LOCK_OPTIONS,
          );
          if (!stream.acquired) {
            throw new Error("Timed out acquiring ACP stream append control");
          }
          return stream.value;
        }
        await fenceLock(args.state, lock, MUTATION_LOCK_TTL_MS);
        await queueReceipt({
          connectionId: args.connectionId,
          receipt,
          requestKey: args.requestKey,
          state: args.state,
        });
        return "accepted" as const;
      },
      MUTATION_LOCK_OPTIONS,
    );
    return result.acquired ? result.value : "busy";
  } catch (error) {
    if (error instanceof AcpStreamFullError) return "full";
    throw error;
  }
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

/** Emit assistant Messages and the final response for one durable Turn. */
async function streamPrompt(args: {
  conversations: ConversationPort;
  connectionId: string;
  emit: EmitAcpMessage;
  output: AcpPromptStreamOutput;
  sessionId: string;
  signal: AbortSignal;
  state: AcpState;
}): Promise<boolean> {
  let cursor = args.output.afterSeq;
  const sentMessageIds = new Set<string>();

  while (!args.signal.aborted) {
    if (!(await connectionIsLive(args.state, args.connectionId))) return false;
    const page = await args.conversations.readTurn({
      afterCursor: cursor,
      conversationId: args.sessionId,
      messageId: args.output.messageId,
      turnId: args.output.turnId,
    });
    cursor = page.cursor;
    if (page.messages.length === 0 && !page.terminal) {
      await sleep(EVENT_POLL_INTERVAL_MS, args.signal);
      continue;
    }

    for (const message of page.messages) {
      if (sentMessageIds.has(message.id)) continue;
      sentMessageIds.add(message.id);
      if (
        !(await args.emit({
          jsonrpc: "2.0",
          method: acp.methods.client.session.update,
          params: {
            sessionId: args.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: message.text },
              messageId: message.id,
            },
          },
        }))
      ) {
        return false;
      }
    }
    if (page.terminal?.status === "completed") {
      return await args.emit(
        resultMessage(args.output.requestId, {
          stopReason:
            page.terminal.outcome === "cancelled" ? "cancelled" : "end_turn",
        } satisfies acp.PromptResponse),
      );
    }
    if (page.terminal?.status === "failed") {
      return await args.emit(
        errorMessage(
          args.output.requestId,
          acp.RequestError.internalError(
            { failureCode: page.terminal.failureCode },
            "Junior Turn failed",
          ),
        ),
      );
    }
  }
  return false;
}

function serializeSseMessage(message: acp.AnyMessage): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(message)}\n\n`);
}

function serializeSseKeepAlive(): Uint8Array {
  return new TextEncoder().encode(":\n\n");
}

/** Open one connection or session SSE reader backed by shared state. */
export async function openAcpSse(args: {
  conversations: ConversationPort;
  maintain?: () => Promise<void>;
  onError?: ReportAcpError;
  requestSignal: AbortSignal;
  route: AcpStreamRoute;
  state: AcpState;
  userId?: string;
}): Promise<Response> {
  const route = acpStreamRouteSchema.parse(args.route);
  const lock = await args.state.acquireLock(
    streamLockKey(route),
    ACP_SSE_LEASE_TTL_MS,
  );
  if (!lock) {
    return new Response("ACP SSE stream already connected", { status: 409 });
  }
  return new Response(createSseBody({ ...args, lock, route }), {
    status: 200,
    headers: {
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream",
    },
  });
}

/** Keep one SSE body alive while it consumes durable stream items in order. */
function createSseBody(args: {
  conversations: ConversationPort;
  lock: AcpLock;
  maintain?: () => Promise<void>;
  onError?: ReportAcpError;
  requestSignal: AbortSignal;
  route: AcpStreamRoute;
  state: AcpState;
  userId?: string;
}): ReadableStream<Uint8Array> {
  const abort = new AbortController();
  let cleaned = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let keepAlive: ReturnType<typeof setInterval> | undefined;
  let leaseExpiresAt = args.lock.expiresAt;
  let nextMaintenanceAtMs = 0;
  let retainingLease: Promise<void> | undefined;

  const correlation: AcpErrorContext = {
    connectionId: args.route.connectionId,
  };
  if (args.route.sessionId) correlation.conversationId = args.route.sessionId;
  if (args.userId) correlation.userId = args.userId;
  const cleanup = async (): Promise<void> => {
    if (cleaned) return;
    cleaned = true;
    abort.abort();
    if (keepAlive) clearInterval(keepAlive);
    if (heartbeat) clearInterval(heartbeat);
    args.requestSignal.removeEventListener("abort", onRequestAbort);
    try {
      await args.state.releaseLock(args.lock);
    } catch (error) {
      args.onError?.(error, "acp.sse.lock_cleanup.exception", correlation);
    }
  };
  const onRequestAbort = (): void => void cleanup();
  const retainLease = async (): Promise<void> => {
    if (retainingLease) return await retainingLease;
    retainingLease = (async () => {
      let extended: boolean;
      try {
        extended = await args.state.extendLock(args.lock, ACP_SSE_LEASE_TTL_MS);
      } catch (error) {
        if (Date.now() < leaseExpiresAt) return;
        throw new Error("ACP SSE stream lease could not be renewed", {
          cause: error,
        });
      }
      if (!extended) {
        throw new Error("ACP SSE stream lease expired");
      }
      leaseExpiresAt = Date.now() + ACP_SSE_LEASE_TTL_MS;
    })();
    try {
      await retainingLease;
    } finally {
      retainingLease = undefined;
    }
  };

  return new ReadableStream<Uint8Array>({
    start(controller) {
      let failureCaptured = false;
      const fail = (error: unknown): void => {
        if (cleaned) return;
        const failure =
          error instanceof Error
            ? error
            : new Error("ACP SSE stream failed", { cause: error });
        if (!failureCaptured) {
          failureCaptured = true;
          args.onError?.(failure, "acp.sse.exception", correlation);
        }
        abort.abort(failure);
        try {
          controller.error(failure);
        } catch {
          // The response stream may already be closed or cancelled.
        }
        void cleanup();
      };

      args.requestSignal.addEventListener("abort", onRequestAbort, {
        once: true,
      });
      if (args.requestSignal.aborted) {
        void cleanup();
        return;
      }
      keepAlive = setInterval(() => {
        if (cleaned || (controller.desiredSize ?? 0) <= 0) return;
        try {
          controller.enqueue(serializeSseKeepAlive());
        } catch (error) {
          fail(error);
        }
      }, SSE_KEEP_ALIVE_MS);
      keepAlive.unref?.();

      heartbeat = setInterval(() => {
        if (cleaned) return;
        void retainLease().catch(fail);
      }, ACP_SSE_LEASE_RENEW_INTERVAL_MS);
      heartbeat.unref?.();

      const emit: EmitAcpMessage = async (message) => {
        while (!abort.signal.aborted && (controller.desiredSize ?? 0) <= 0) {
          await sleep(EVENT_POLL_INTERVAL_MS, abort.signal);
        }
        if (
          abort.signal.aborted ||
          !(await connectionIsLive(args.state, args.route.connectionId))
        ) {
          abort.abort();
          return false;
        }
        await retainLease();
        controller.enqueue(serializeSseMessage(message));
        return true;
      };

      const pump = async (): Promise<void> => {
        let cursor = await readStreamCursor(args.state, args.route);
        while (!abort.signal.aborted) {
          if (!(await connectionIsLive(args.state, args.route.connectionId))) {
            return;
          }
          if (args.maintain && Date.now() >= nextMaintenanceAtMs) {
            nextMaintenanceAtMs = Date.now() + SSE_MAINTENANCE_INTERVAL_MS;
            await args.maintain();
          }

          const items = await readStreamItems(args.state, args.route);
          const cursorIndex = cursor
            ? items.findIndex((item) => item.id === cursor)
            : -1;
          const pending = items.slice(cursorIndex >= 0 ? cursorIndex + 1 : 0);
          if (pending.length === 0) {
            await sleep(EVENT_POLL_INTERVAL_MS, abort.signal);
            continue;
          }

          for (const item of pending) {
            if (abort.signal.aborted) return;
            // ACP v1 does not replay in-flight transport output. Advance before
            // emission so a lost lease cannot duplicate a delivered message.
            await retainLease();
            await args.state.set(
              streamCursorKey(args.route),
              acpStreamCursorSchema.parse({ itemId: item.id }),
              ACP_STATE_TTL_MS,
            );
            cursor = item.id;
            let delivered: boolean;
            if (item.output.kind === "message") {
              delivered = await emit(item.output.message);
            } else {
              const sessionId = args.route.sessionId;
              if (!sessionId) {
                throw new Error(
                  `ACP ${item.output.kind} output requires a session stream`,
                );
              }
              delivered =
                item.output.kind === "replay"
                  ? await streamSessionReplay({
                      conversations: args.conversations,
                      emit,
                      sessionId,
                      signal: abort.signal,
                    })
                  : await streamPrompt({
                      conversations: args.conversations,
                      connectionId: args.route.connectionId,
                      emit,
                      output: item.output,
                      sessionId,
                      signal: abort.signal,
                      state: args.state,
                    });
            }
            if (!delivered || abort.signal.aborted) return;
          }
        }
      };

      void pump()
        .then(() => {
          if (!cleaned) controller.close();
        })
        .catch((error: unknown) => {
          if (!cleaned && !args.requestSignal.aborted) fail(error);
        })
        .finally(cleanup);
    },
    async cancel() {
      await cleanup();
    },
  });
}
