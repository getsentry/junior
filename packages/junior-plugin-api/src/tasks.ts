/**
 * Public plugin background-task contracts.
 *
 * Plugins register small task handlers, while Junior core owns durable
 * scheduling, queue delivery, retries, and the bounded session projection.
 */
import { z } from "zod";
import type { PluginContext } from "./context";
import { destinationSchema, requesterSchema, sourceSchema } from "./schemas";
import type { PluginState } from "./state";

/** Bounded message projection exposed by completed-session plugin tasks. */
export const pluginSessionMessageSchema = z
  .object({
    role: z.enum(["user", "assistant"]),
    text: z.string().min(1),
  })
  .strict();

/** Runtime-owned completed-session projection exposed to plugin tasks. */
export const pluginSessionContextSchema = z
  .object({
    completedAtMs: z.number().finite(),
    conversationId: z.string().min(1),
    destination: destinationSchema,
    messages: z.array(pluginSessionMessageSchema),
    requester: requesterSchema.optional(),
    sessionId: z.string().min(1),
    source: sourceSchema,
    toolCalls: z.array(z.string().min(1)),
  })
  .strict();

export type PluginSessionMessage = z.output<typeof pluginSessionMessageSchema>;

export type PluginSessionContext = z.output<typeof pluginSessionContextSchema>;

/** Runtime context passed to a plugin-owned background task. */
export interface PluginTaskContext extends PluginContext {
  id: string;
  name: string;
  session: {
    load(): Promise<PluginSessionContext>;
  };
  state: PluginState;
}

/** Plugin task handler registered by name in a plugin manifest module. */
export interface PluginTaskDefinition {
  run(ctx: PluginTaskContext): Promise<void> | void;
}

/** Task handlers keyed by the plugin-owned task name. */
export type PluginTasks = Record<string, PluginTaskDefinition>;
