import { createQueueMessageCodec } from "@/chat/queue-jobs/message";
import {
  pluginTaskQueueMessageSchema,
  type PluginTaskQueueMessage,
} from "./task-message";

const pluginTaskQueueMessageCodec =
  createQueueMessageCodec<PluginTaskQueueMessage, "v1">({
    context: "junior.plugin_task_queue.v1",
    schema: pluginTaskQueueMessageSchema,
    signatureVersion: "v1",
    signingParts: (message) => [
      message.plugin,
      message.name,
      message.params.conversationId,
      message.params.sessionId,
    ],
  });

export type PluginTaskQueueRejectReason =
  | "expired"
  | "malformed"
  | "signature_mismatch";
export const PLUGIN_TASK_QUEUE_SIGNATURE_MAX_SKEW_MS =
  pluginTaskQueueMessageCodec.maxAgeMs;

/** Sign a plugin task payload before it crosses the public queue callback. */
export function signPluginTaskQueueMessage(
  message: PluginTaskQueueMessage,
  nowMs = Date.now(),
) {
  return pluginTaskQueueMessageCodec.sign(message, nowMs);
}

/** Verify a plugin task payload from the public queue callback route. */
export function verifyPluginTaskQueueMessage(
  value: unknown,
  nowMs = Date.now(),
) {
  return pluginTaskQueueMessageCodec.verify(value, nowMs);
}
