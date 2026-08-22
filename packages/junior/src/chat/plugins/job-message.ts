import { createHash } from "node:crypto";
import { z } from "zod";

export const pluginJobParamsSchema = z
  .object({
    conversationId: z.string().min(1),
    sessionId: z.string().min(1),
  })
  .strict();

export type PluginJobParams = z.output<typeof pluginJobParamsSchema>;

export const pluginJobMessageSchema = z
  .object({
    name: z.string().min(1),
    params: pluginJobParamsSchema,
    plugin: z.string().min(1),
  })
  .strict();

export type PluginJobMessage = z.output<typeof pluginJobMessageSchema>;

/** Build the stable id used for delivery dedupe and tracing. */
export function pluginJobId(args: {
  name: string;
  params: PluginJobParams;
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
  return `plugin-job_${digest}`;
}

/** Parse the bounded payload accepted by the plugin job callback. */
export function parsePluginJobMessage(
  value: unknown,
): PluginJobMessage | undefined {
  const parsed = pluginJobMessageSchema.safeParse(value);
  if (!parsed.success) {
    return undefined;
  }
  return parsed.data;
}
