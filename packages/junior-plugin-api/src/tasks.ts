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

/**
 * Runtime-owned provenance for a transcript message: whether it is a durable
 * instruction or ambient context, plus the actor identity when known. Missing
 * provenance on an entry means unattributed context.
 */
export const pluginRunTranscriptProvenanceSchema = z
  .object({
    authority: z.enum(["instruction", "context"]),
    actor: actorSchema.optional(),
  })
  .strict();

/** One normalized transcript entry from the completed run exposed to plugin tasks. */
export const pluginRunTranscriptEntrySchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("message"),
      role: z.enum(["user", "assistant"]),
      text: z.string().min(1),
      provenance: pluginRunTranscriptProvenanceSchema.optional(),
      isRunActor: z.boolean().optional(),
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

export type PluginRunTranscriptProvenance = z.output<
  typeof pluginRunTranscriptProvenanceSchema
>;

/** Runtime-owned completed-run projection exposed to plugin tasks. */
export const pluginRunContextSchema = z
  .object({
    completedAtMs: z.number().finite(),
    conversationId: z.string().min(1),
    destination: destinationSchema,
    /**
     * All distinct actors annotated on this run's committed instruction-authority
     * messages, in first-seen order. Attribution provenance only, never an
     * authority source: a plugin must not treat membership here as credential,
     * subject, or scope ownership. Derived from full-run provenance, so it can
     * exceed the actors visible in the transcript slice. Usually `[run.actor]`;
     * possibly empty for system runs with no human instructions.
     */
    actors: z.array(actorSchema),
    /**
     * The single actor this run executes as. Absent only for actor-less legacy
     * system records, so authority-sensitive plugins must fail closed.
     */
    actor: actorSchema.optional(),
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
