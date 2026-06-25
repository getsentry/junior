import { createHash } from "node:crypto";
import { z } from "zod";
import { pluginTaskParamsSchema } from "@sentry/junior-plugin-api";

const pluginTaskQueueMessageSchema = z
  .object({
    name: z.string().min(1),
    params: pluginTaskParamsSchema,
    plugin: z.string().min(1),
    trigger: z.literal("session.completed"),
  })
  .strict();

export type PluginTaskQueueMessage = z.output<
  typeof pluginTaskQueueMessageSchema
>;

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
export function pluginTaskId(args: {
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
