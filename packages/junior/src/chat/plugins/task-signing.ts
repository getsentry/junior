import {
  QUEUE_SIGNATURE_MAX_AGE_MS,
  signQueueMessage,
  verifyQueueMessage,
  type QueueRejectReason,
} from "@/chat/queue/sign";
import {
  pluginTaskQueueMessageSchema,
  type PluginTaskQueueMessage,
} from "./task-message";

const pluginTaskQueueSign = {
  context: "junior.plugin_task_queue.v1",
  schema: pluginTaskQueueMessageSchema,
  signatureVersion: "v1" as const,
  parts: (message: PluginTaskQueueMessage) => [
    message.plugin,
    message.name,
    message.params.conversationId,
    message.params.sessionId,
  ],
};

export type PluginTaskQueueRejectReason = QueueRejectReason;
export const PLUGIN_TASK_QUEUE_SIGNATURE_MAX_SKEW_MS =
  QUEUE_SIGNATURE_MAX_AGE_MS;

/** Sign a plugin task payload before it crosses the public queue callback. */
export function signPluginTaskQueueMessage(
  message: PluginTaskQueueMessage,
  nowMs = Date.now(),
) {
  return signQueueMessage(pluginTaskQueueSign, message, nowMs);
}

/** Verify a plugin task payload from the public queue callback route. */
export function verifyPluginTaskQueueMessage(
  value: unknown,
  nowMs = Date.now(),
) {
  return verifyQueueMessage(pluginTaskQueueSign, value, nowMs);
}
