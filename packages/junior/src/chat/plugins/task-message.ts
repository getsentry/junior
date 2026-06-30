import { createHash } from "node:crypto";
import { z } from "zod";

export const pluginTaskParamsSchema = z
  .object({
    conversationId: z.string().min(1),
    sessionId: z.string().min(1),
  })
  .strict();

export type PluginTaskParams = z.output<typeof pluginTaskParamsSchema>;

export const pluginTaskQueueMessageSchema = z
  .object({
    name: z.string().min(1),
    params: pluginTaskParamsSchema,
    plugin: z.string().min(1),
  })
  .strict();

export type PluginTaskQueueMessage = z.output<
  typeof pluginTaskQueueMessageSchema
>;

/** Build the stable task id used for queue idempotency and tracing. */
export function pluginTaskId(args: {
  name: string;
  params: PluginTaskParams;
  plugin: string;
}): string {
  const digest = createHash("sha256")
    .update(args.plugin)
    .update("\0")
    .update(args.name)
    .update("\0")
    .update(args.params.conversationId)
    .update("\0")
    .update(args.params.sessionId)
    .digest("hex")
    .slice(0, 32);
  return `plugin-task_${digest}`;
}

/** Parse the bounded queue payload accepted by the plugin task callback. */
export function parsePluginTaskQueueMessage(
  value: unknown,
): PluginTaskQueueMessage | undefined {
  const parsed = pluginTaskQueueMessageSchema.safeParse(value);
  if (!parsed.success) {
    return undefined;
  }
  return parsed.data;
}
