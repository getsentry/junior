/**
 * Public plugin background-task contracts.
 *
 * Plugins register small task handlers, while Junior core owns durable
 * scheduling, queue delivery, retries, and the bounded session projection.
 */
import { z } from "zod";
import type { PluginContext, PluginEmbedder, PluginModel } from "./context";
import type { Requester } from "./context";
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

/** Core-owned reference params for the completed session a task should process. */
export const pluginTaskParamsSchema = z
  .object({
    conversationId: z.string().min(1),
    sessionId: z.string().min(1),
  })
  .strict();

export type PluginTaskParams = z.output<typeof pluginTaskParamsSchema>;

export interface PluginSessionReader {
  load(): Promise<PluginSessionContext>;
}

export interface PluginTaskContext extends PluginContext {
  embedder: PluginEmbedder;
  id: string;
  model: PluginModel;
  name: string;
  params: PluginTaskParams;
  session: PluginSessionReader;
  state: PluginState;
}

export interface PluginTaskDefinition {
  run(ctx: PluginTaskContext): Promise<void> | void;
}

export type PluginTasks = Record<string, PluginTaskDefinition>;
