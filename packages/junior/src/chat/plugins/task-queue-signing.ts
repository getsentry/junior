import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { pluginTaskParamsSchema } from "@sentry/junior-plugin-api";

const PLUGIN_TASK_QUEUE_SIGNATURE_CONTEXT = "junior.plugin_task_queue.v1";
const PLUGIN_TASK_QUEUE_SIGNATURE_VERSION = "v1";
export const PLUGIN_TASK_QUEUE_SIGNATURE_MAX_SKEW_MS = 24 * 60 * 60 * 1000;

const pluginTaskQueueMessageSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    params: pluginTaskParamsSchema,
    plugin: z.string().min(1),
    trigger: z.literal("session.completed"),
  })
  .strict();

const signedPluginTaskQueueMessageSchema = pluginTaskQueueMessageSchema
  .extend({
    signature: z.string().min(1),
    signatureVersion: z.literal(PLUGIN_TASK_QUEUE_SIGNATURE_VERSION),
    signedAtMs: z.number().finite(),
  })
  .strict();

export type PluginTaskQueueMessage = z.output<
  typeof pluginTaskQueueMessageSchema
>;

type SignedPluginTaskQueueMessage = z.output<
  typeof signedPluginTaskQueueMessageSchema
>;

export type PluginTaskQueueMessageVerificationResult =
  | {
      message: PluginTaskQueueMessage;
      status: "verified";
    }
  | {
      reason: "expired" | "malformed" | "signature_mismatch" | "id_mismatch";
      status: "rejected";
    }
  | {
      reason: "invalid_clock" | "missing_secret";
      status: "unavailable";
    };

function stableParams(params: Record<string, unknown>): string {
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(params).sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    ),
  );
}

/** Build the stable task id used for queue idempotency and tracing. */
export function getPluginTaskId(args: {
  name: string;
  params: z.output<typeof pluginTaskParamsSchema>;
  plugin: string;
  trigger: PluginTaskQueueMessage["trigger"];
}): string {
  const digest = createHash("sha256")
    .update(args.plugin)
    .update("\0")
    .update(args.name)
    .update("\0")
    .update(args.trigger)
    .update("\0")
    .update(stableParams(args.params))
    .digest("hex")
    .slice(0, 32);
  return `plugin-task_${digest}`;
}

/** Build a signed-queue-ready plugin task request from parsed params. */
export function createPluginTaskQueueMessage(args: {
  name: string;
  params: z.output<typeof pluginTaskParamsSchema>;
  plugin: string;
  trigger: PluginTaskQueueMessage["trigger"];
}): PluginTaskQueueMessage {
  return {
    ...args,
    id: getPluginTaskId(args),
  };
}

function getPluginTaskQueueSecret(): string | undefined {
  return process.env.JUNIOR_SECRET?.trim() || undefined;
}

/** Build the stable HMAC payload for the signed task message. */
function buildSignedPayload(
  message: PluginTaskQueueMessage,
  signedAtMs: number,
) {
  return [
    PLUGIN_TASK_QUEUE_SIGNATURE_CONTEXT,
    signedAtMs,
    message.id,
    message.plugin,
    message.name,
    message.trigger,
    stableParams(message.params),
  ].join(":");
}

/** Sign the stable queue-envelope payload with Junior's host secret. */
function signPayload(
  message: PluginTaskQueueMessage,
  signedAtMs: number,
  secret: string,
): string {
  return createHmac("sha256", secret)
    .update(buildSignedPayload(message, signedAtMs))
    .digest("hex");
}

function timingSafeMatch(expected: string, actual: string): boolean {
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(actual);
  if (expectedBuffer.length !== actualBuffer.length) {
    return false;
  }
  return timingSafeEqual(expectedBuffer, actualBuffer);
}

/** Parse only the signed task-message fields accepted by the callback route. */
function parseSignedPluginTaskQueueMessage(
  value: unknown,
): SignedPluginTaskQueueMessage | undefined {
  const parsed = signedPluginTaskQueueMessageSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/** Sign a plugin task queue payload before it crosses the callback route. */
export function signPluginTaskQueueMessage(
  message: PluginTaskQueueMessage,
  nowMs = Date.now(),
): SignedPluginTaskQueueMessage {
  const secret = getPluginTaskQueueSecret();
  if (!secret) {
    throw new Error(
      "Cannot sign plugin task queue message without JUNIOR_SECRET",
    );
  }
  return {
    ...message,
    signedAtMs: nowMs,
    signatureVersion: PLUGIN_TASK_QUEUE_SIGNATURE_VERSION,
    signature: signPayload(message, nowMs, secret),
  };
}

/** Explain whether a plugin task queue payload is verified, rejected, or temporarily unverifiable. */
export function verifyPluginTaskQueueMessage(
  value: unknown,
  nowMs = Date.now(),
): PluginTaskQueueMessageVerificationResult {
  const message = parseSignedPluginTaskQueueMessage(value);
  if (!message) {
    return { status: "rejected", reason: "malformed" };
  }
  const secret = getPluginTaskQueueSecret();
  if (!secret) {
    return { status: "unavailable", reason: "missing_secret" };
  }
  if (!Number.isFinite(nowMs)) {
    return { status: "unavailable", reason: "invalid_clock" };
  }
  if (message.id !== getPluginTaskId(message)) {
    return { status: "rejected", reason: "id_mismatch" };
  }
  if (
    nowMs - message.signedAtMs > PLUGIN_TASK_QUEUE_SIGNATURE_MAX_SKEW_MS ||
    message.signedAtMs - nowMs > PLUGIN_TASK_QUEUE_SIGNATURE_MAX_SKEW_MS
  ) {
    return { status: "rejected", reason: "expired" };
  }
  const expected = signPayload(message, message.signedAtMs, secret);
  if (!timingSafeMatch(expected, message.signature)) {
    return { status: "rejected", reason: "signature_mismatch" };
  }
  return {
    status: "verified",
    message: {
      id: message.id,
      name: message.name,
      params: message.params,
      plugin: message.plugin,
      trigger: message.trigger,
    },
  };
}
