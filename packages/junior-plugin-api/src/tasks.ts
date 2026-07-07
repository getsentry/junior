/**
 * Public plugin background-task contracts.
 *
 * Plugins register small task handlers, while Junior core owns durable
 * scheduling, queue delivery, retries, and the bounded run projection.
 */
import { z } from "zod";
import type { PluginContext, PluginEmbedder, PluginModel } from "./context";
import { destinationSchema, actorSchema, sourceSchema } from "./schemas";
import type { PluginState } from "./state";

/** One normalized transcript entry from the completed run exposed to plugin tasks. */
export const pluginRunTranscriptEntrySchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("message"),
      role: z.enum(["user", "assistant"]),
      text: z.string().min(1),
    })
    .strict(),
  z
    .object({
      type: z.literal("toolResult"),
      toolName: z.string().min(1),
      isError: z.boolean(),
      text: z.string().min(1).optional(),
    })
    .strict(),
]);

/** Runtime-owned completed-run projection exposed to plugin tasks. */
export const pluginRunContextSchema = z
  .object({
    completedAtMs: z.number().finite(),
    conversationId: z.string().min(1),
    destination: destinationSchema,
    actor: actorSchema,
    runId: z.string().min(1),
    source: sourceSchema,
    transcript: z.array(pluginRunTranscriptEntrySchema),
  })
  .strict();

export type PluginRunTranscriptEntry = z.output<
  typeof pluginRunTranscriptEntrySchema
>;

export type PluginRunContext = z.output<typeof pluginRunContextSchema>;

/** Runtime context passed to a plugin-owned background task. */
export interface PluginTaskContext extends PluginContext {
  embedder: PluginEmbedder;
  id: string;
  model: PluginModel;
  name: string;
  run: {
    load(): Promise<PluginRunContext>;
  };
  state: PluginState;
}

/** Plugin task handler registered by name in a plugin manifest module. */
export interface PluginTaskDefinition {
  run(ctx: PluginTaskContext): Promise<void> | void;
}

/** Task handlers keyed by the plugin-owned task name. */
export type PluginTasks = Record<string, PluginTaskDefinition>;
