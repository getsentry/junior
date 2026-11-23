// A local, in-memory server for the Vercel Queues HTTP API, for development
// and tests. Point `QueueClient` from `@vercel/queue` at it with
// `resolveBaseUrl`, and it stores messages, pushes them to consumer callback
// routes, and redelivers a message when its lease expires without an ack, as
// Vercel Queues does.
//
// It implements only what `QueueClient` uses (https://vercel.com/docs/queues/api):
// SendMessage, ReceiveMessageById with `multipart/mixed`, AcknowledgeMessage,
// and ExtendLease. Pushes use the v1beta structured CloudEvent, so each
// callback claims its message with ReceiveMessageById.
//
// Differences from Vercel Queues: any bearer token is accepted,
// `Vqs-Deployment-Id` is ignored, retention below 60 seconds is accepted so
// tests can check expiry, and ReceiveMessages and `application/x-ndjson` are
// not implemented.
//
// Keep this file free of path aliases and non-erasable TypeScript, so that
// Node can run it directly in a dev process.
import { randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import * as z from "zod";

const API_PATH = "/api/v3/topic/";
const CLOUD_EVENT_TYPE = "com.vercel.queue.v1beta";
const NAME_PATTERN = /^[A-Za-z0-9_-]+$/;
const DEFAULT_RETENTION_SECONDS = 24 * 60 * 60;
const MAX_RETENTION_SECONDS = 7 * 24 * 60 * 60;
const DEFAULT_VISIBILITY_TIMEOUT_SECONDS = 60;
const MAX_VISIBILITY_TIMEOUT_SECONDS = 60 * 60;
const MAX_IDEMPOTENCY_KEY_LENGTH = 256;
// Wait this long before pushing again when a push did not claim the message,
// for example because the callback route failed before it received it.
const PUSH_RETRY_MS = 1_000;

const extendLeaseBodySchema = z
  .object({
    visibilityTimeoutSeconds: z
      .number()
      .int()
      .min(0)
      .max(MAX_VISIBILITY_TIMEOUT_SECONDS),
  })
  .strict();

/** One consumer group of one topic, and the callback route it receives pushes on. */
export interface LocalVercelQueueConsumer {
  consumerGroup: string;
  topic: string;
  /** Callback route URL. The server POSTs a CloudEvent to it for each message. */
  url: string;
}

/** Options for {@link startLocalVercelQueueServer}. */
export interface LocalVercelQueueServerOptions {
  consumers: LocalVercelQueueConsumer[];
  /** Sends each push. Defaults to the global `fetch`. */
  fetch?: (request: Request) => Promise<Response>;
  /**
   * Shorten each lease to at most this many seconds. `@vercel/queue` asks for
   * at least 30 seconds, so tests set this to see redelivery sooner.
   */
  maxLeaseSeconds?: number;
  /** Port on 127.0.0.1. Defaults to a free port. */
  port?: number;
}

/** A running local Vercel Queues server. */
export interface LocalVercelQueueServer {
  /** Base URL for `QueueClient`'s `resolveBaseUrl`. */
  readonly url: URL;
  /** Stop pushes, wait for running pushes, and stop listening. */
  close(): Promise<void>;
}

interface GroupState {
  acked: boolean;
  consumer: LocalVercelQueueConsumer;
  deliveryCount: number;
  receiptHandle: string | undefined;
  timer: NodeJS.Timeout | undefined;
  /** Set while a push runs and its callback has not claimed the message. */
  unclaimedPush: symbol | undefined;
  /** The message is hidden from this group until this time (delay or lease). */
  visibleAt: number;
}

interface StoredMessage {
  body: Buffer;
  contentType: string;
  createdAt: number;
  duplicateIds: string[];
  expiresAt: number;
  expiryTimer: NodeJS.Timeout;
  groups: Map<string, GroupState>;
  id: string;
  idempotencyKey: string | undefined;
  topic: string;
}

interface Reply {
  body?: string | Buffer;
  headers?: Record<string, string>;
  status: number;
}

function json(status: number, value: unknown): Reply {
  return {
    body: JSON.stringify(value),
    headers: { "content-type": "application/json" },
    status,
  };
}

function error(status: number, message: string): Reply {
  return json(status, { error: message });
}

function readSeconds(
  request: IncomingMessage,
  name: string,
  min: number,
  max: number,
): number | undefined | Error {
  const raw = request.headers[name.toLowerCase()];
  if (raw === undefined) {
    return undefined;
  }
  const value = Number(raw);
  if (
    typeof raw !== "string" ||
    !/^\d+$/.test(raw) ||
    value < min ||
    value > max
  ) {
    return new Error(`${name} must be an integer from ${min} to ${max}`);
  }
  return value;
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks);
}

/** Start a local Vercel Queues API server that pushes to `consumers`. */
export async function startLocalVercelQueueServer(
  options: LocalVercelQueueServerOptions,
): Promise<LocalVercelQueueServer> {
  const pushFetch = options.fetch ?? fetch;
  const maxLeaseMs =
    (options.maxLeaseSeconds ?? MAX_VISIBILITY_TIMEOUT_SECONDS) * 1000;
  const messages = new Map<string, StoredMessage>();
  const duplicates = new Map<string, string>();
  const idempotencyKeys = new Map<string, string>();
  const leases = new Map<
    string,
    { group: GroupState; message: StoredMessage }
  >();
  const runningPushes = new Set<Promise<void>>();
  let closing = false;

  const leaseUntil = (message: StoredMessage, seconds: number) =>
    Math.min(
      Date.now() + Math.min(seconds * 1000, maxLeaseMs),
      message.expiresAt,
    );

  const isLeased = (group: GroupState) =>
    group.receiptHandle !== undefined && group.visibleAt > Date.now();

  // Push the message to the group's callback once it is visible.
  const schedule = (message: StoredMessage, group: GroupState) => {
    clearTimeout(group.timer);
    group.timer = undefined;
    const now = Date.now();
    if (
      closing ||
      group.acked ||
      group.unclaimedPush !== undefined ||
      now >= message.expiresAt
    ) {
      return;
    }
    if (group.visibleAt > now) {
      group.timer = setTimeout(
        () => schedule(message, group),
        group.visibleAt - now,
      );
      group.timer.unref();
      return;
    }
    const push = deliver(message, group);
    runningPushes.add(push);
    void push.finally(() => runningPushes.delete(push));
  };

  const deliver = async (message: StoredMessage, group: GroupState) => {
    const { consumer } = group;
    const push = Symbol("push");
    group.unclaimedPush = push;
    try {
      const response = await pushFetch(
        new Request(consumer.url, {
          body: JSON.stringify({
            data: {
              consumerGroup: consumer.consumerGroup,
              messageId: message.id,
              queueName: message.topic,
            },
            id: randomUUID(),
            source: "local-vercel-queue",
            specversion: "1.0",
            type: CLOUD_EVENT_TYPE,
          }),
          headers: { "content-type": "application/cloudevents+json" },
          method: "POST",
        }),
      );
      await response.arrayBuffer();
    } catch {
      // The callback route is down. Push again after PUSH_RETRY_MS.
    } finally {
      if (group.unclaimedPush === push) {
        group.unclaimedPush = undefined;
      }
      if (!group.acked && !isLeased(group)) {
        group.visibleAt = Math.max(group.visibleAt, Date.now() + PUSH_RETRY_MS);
      }
      schedule(message, group);
    }
  };

  const expire = (message: StoredMessage) => {
    messages.delete(message.id);
    for (const id of message.duplicateIds) {
      duplicates.delete(id);
    }
    if (message.idempotencyKey !== undefined) {
      idempotencyKeys.delete(message.idempotencyKey);
    }
    for (const group of message.groups.values()) {
      clearTimeout(group.timer);
      if (group.receiptHandle !== undefined) {
        leases.delete(group.receiptHandle);
      }
    }
  };

  const sendMessage = async (
    request: IncomingMessage,
    topic: string,
  ): Promise<Reply> => {
    const retention =
      readSeconds(request, "Vqs-Retention-Seconds", 1, MAX_RETENTION_SECONDS) ??
      DEFAULT_RETENTION_SECONDS;
    const delay =
      readSeconds(request, "Vqs-Delay-Seconds", 0, MAX_RETENTION_SECONDS) ?? 0;
    if (retention instanceof Error) {
      return error(400, retention.message);
    }
    if (delay instanceof Error) {
      return error(400, delay.message);
    }
    const rawKey = request.headers["vqs-idempotency-key"];
    if (
      Array.isArray(rawKey) ||
      (rawKey?.length ?? 0) > MAX_IDEMPOTENCY_KEY_LENGTH
    ) {
      return error(400, "Invalid Vqs-Idempotency-Key");
    }
    const body = await readBody(request);
    const id = `msg_${randomUUID()}`;
    const reply: Reply = {
      body: JSON.stringify({ messageId: id }),
      headers: { "content-type": "application/json", "vqs-message-id": id },
      status: 201,
    };
    const key = rawKey === undefined ? undefined : `${topic}\n${rawKey}`;
    const original =
      key === undefined
        ? undefined
        : messages.get(idempotencyKeys.get(key) ?? "");
    // The expiry timer can fire late. An expired message no longer dedupes.
    if (original && Date.now() >= original.expiresAt) {
      clearTimeout(original.expiryTimer);
      expire(original);
    } else if (original) {
      // Vercel accepts a duplicate with its own ID and drops it.
      original.duplicateIds.push(id);
      duplicates.set(id, original.id);
      return reply;
    }
    const createdAt = Date.now();
    const expiresAt = createdAt + retention * 1000;
    const message: StoredMessage = {
      body,
      contentType:
        request.headers["content-type"] ?? "application/octet-stream",
      createdAt,
      duplicateIds: [],
      expiresAt,
      expiryTimer: setTimeout(() => expire(message), expiresAt - createdAt),
      groups: new Map(),
      id,
      idempotencyKey: key,
      topic,
    };
    message.expiryTimer.unref();
    messages.set(id, message);
    if (key !== undefined) {
      idempotencyKeys.set(key, id);
    }
    for (const consumer of options.consumers) {
      if (consumer.topic !== topic) {
        continue;
      }
      const group: GroupState = {
        acked: false,
        consumer,
        deliveryCount: 0,
        receiptHandle: undefined,
        timer: undefined,
        unclaimedPush: undefined,
        visibleAt: createdAt + delay * 1000,
      };
      message.groups.set(consumer.consumerGroup, group);
      schedule(message, group);
    }
    return reply;
  };

  const receiveMessageById = (
    request: IncomingMessage,
    topic: string,
    consumerGroup: string,
    messageId: string,
  ): Reply => {
    if (!request.headers.accept?.includes("multipart/mixed")) {
      return error(400, "Accept must include multipart/mixed");
    }
    const timeout =
      readSeconds(
        request,
        "Vqs-Visibility-Timeout-Seconds",
        0,
        MAX_VISIBILITY_TIMEOUT_SECONDS,
      ) ?? DEFAULT_VISIBILITY_TIMEOUT_SECONDS;
    if (timeout instanceof Error) {
      return error(400, timeout.message);
    }
    const originalMessageId = duplicates.get(messageId);
    if (originalMessageId !== undefined) {
      return json(409, { originalMessageId });
    }
    const message = messages.get(messageId);
    if (
      !message ||
      message.topic !== topic ||
      Date.now() >= message.expiresAt
    ) {
      return error(404, "Message not found");
    }
    const group = message.groups.get(consumerGroup);
    if (!group) {
      return error(404, "Message not found for this consumer group");
    }
    if (group.acked) {
      return error(410, "Message already acknowledged");
    }
    if (group.visibleAt > Date.now()) {
      return error(409, "Message is locked or delayed");
    }
    if (group.receiptHandle !== undefined) {
      leases.delete(group.receiptHandle);
    }
    const receiptHandle = `rh_${randomUUID()}`;
    group.receiptHandle = receiptHandle;
    group.deliveryCount += 1;
    group.visibleAt = leaseUntil(message, timeout);
    group.unclaimedPush = undefined;
    leases.set(receiptHandle, { group, message });
    schedule(message, group);

    const boundary = `vqs-boundary-${randomUUID()}`;
    const partHeaders = [
      `Content-Type: ${message.contentType}`,
      `Vqs-Message-Id: ${message.id}`,
      `Vqs-Receipt-Handle: ${receiptHandle}`,
      `Vqs-Delivery-Count: ${group.deliveryCount}`,
      `Vqs-Timestamp: ${new Date(message.createdAt).toISOString()}`,
      `Vqs-Expires-At: ${new Date(message.expiresAt).toISOString()}`,
    ].join("\r\n");
    return {
      body: Buffer.concat([
        Buffer.from(`--${boundary}\r\n${partHeaders}\r\n\r\n`),
        message.body,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]),
      headers: { "content-type": `multipart/mixed; boundary=${boundary}` },
      status: 200,
    };
  };

  const findLease = (
    topic: string,
    consumerGroup: string,
    receiptHandle: string,
  ) => {
    const lease = leases.get(receiptHandle);
    if (
      !lease ||
      lease.message.topic !== topic ||
      lease.message.groups.get(consumerGroup) !== lease.group
    ) {
      return undefined;
    }
    return lease;
  };

  const acknowledgeMessage = (
    topic: string,
    consumerGroup: string,
    receiptHandle: string,
  ): Reply => {
    const lease = findLease(topic, consumerGroup, receiptHandle);
    if (lease?.group.acked) {
      return { status: 204 };
    }
    if (!lease || !isLeased(lease.group)) {
      return error(409, "Message is not in flight or the lease expired");
    }
    lease.group.acked = true;
    schedule(lease.message, lease.group);
    return { status: 204 };
  };

  const extendLease = async (
    request: IncomingMessage,
    topic: string,
    consumerGroup: string,
    receiptHandle: string,
  ): Promise<Reply> => {
    let input: unknown;
    try {
      input = JSON.parse((await readBody(request)).toString("utf8"));
    } catch {
      return error(400, "Body must be JSON");
    }
    const parsed = extendLeaseBodySchema.safeParse(input);
    if (!parsed.success) {
      return error(400, "Invalid visibilityTimeoutSeconds");
    }
    const lease = findLease(topic, consumerGroup, receiptHandle);
    if (!lease || lease.group.acked || !isLeased(lease.group)) {
      return error(409, "Message is not in flight or the lease expired");
    }
    const seconds = parsed.data.visibilityTimeoutSeconds;
    if (Date.now() + seconds * 1000 > lease.message.expiresAt) {
      return error(400, "Lease would extend beyond message expiration");
    }
    lease.group.visibleAt = leaseUntil(lease.message, seconds);
    schedule(lease.message, lease.group);
    return json(200, { success: true });
  };

  const route = async (request: IncomingMessage): Promise<Reply> => {
    if (!request.headers.authorization?.startsWith("Bearer ")) {
      return error(401, "Missing bearer token");
    }
    const { pathname } = new URL(request.url ?? "/", "http://localhost");
    if (!pathname.startsWith(API_PATH)) {
      return error(404, "Not found");
    }
    const parts = pathname
      .slice(API_PATH.length)
      .split("/")
      .map(decodeURIComponent);
    const [topic, consumerPart, consumerGroup, kind, id, suffix] = parts;
    if (!topic || !NAME_PATTERN.test(topic) || topic.length > 256) {
      return error(400, "Invalid topic name");
    }
    if (parts.length === 1 && request.method === "POST") {
      return sendMessage(request, topic);
    }
    if (
      consumerPart !== "consumer" ||
      !consumerGroup ||
      !NAME_PATTERN.test(consumerGroup) ||
      !id
    ) {
      return error(404, "Not found");
    }
    if (kind === "id" && parts.length === 5 && request.method === "POST") {
      return receiveMessageById(request, topic, consumerGroup, id);
    }
    if (kind === "lease" && parts.length === 5 && request.method === "DELETE") {
      return acknowledgeMessage(topic, consumerGroup, id);
    }
    if (
      kind === "lease" &&
      request.method === "PATCH" &&
      (parts.length === 5 || (parts.length === 6 && suffix === "visibility"))
    ) {
      return extendLease(request, topic, consumerGroup, id);
    }
    return error(404, "Not found");
  };

  const respond = (reply: Reply, response: ServerResponse) => {
    response.writeHead(reply.status, reply.headers);
    response.end(reply.body);
  };

  const server = createServer((request, response) => {
    route(request).then(
      (reply) => respond(reply, response),
      (failure: unknown) => {
        // Keep exception text out of the response. Log it for the developer.
        console.error("Local Vercel Queues server request failed:", failure);
        respond(error(500, "Internal server error"), response);
      },
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", () => resolve());
  });
  const address: AddressInfo | string | null = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Local Vercel Queues server has no TCP address");
  }

  return {
    url: new URL(`http://127.0.0.1:${address.port}`),
    close: async () => {
      closing = true;
      for (const message of messages.values()) {
        clearTimeout(message.expiryTimer);
        for (const group of message.groups.values()) {
          clearTimeout(group.timer);
        }
      }
      // A running callback still calls this server to ack its message.
      await Promise.allSettled(runningPushes);
      await new Promise<void>((resolve, reject) => {
        server.close((failure) => (failure ? reject(failure) : resolve()));
        server.closeAllConnections();
      });
    },
  };
}
