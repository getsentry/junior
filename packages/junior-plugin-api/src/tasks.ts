/**
 * Public plugin background-task contracts.
 *
 * Plugins register small task handlers. Junior core owns scheduling, delivery,
 * retries, and the bounded run projection.
 */
import * as z from "zod";
import type { PluginConversationAnnotations } from "./annotations";
import type { PluginCodeChanges } from "./code";
import type { PluginConversationChanges } from "./conversation-changes";
import type {
  PluginConversationEvents,
  PluginTurnEventReader,
} from "./conversation-events";
import type { PluginContext, PluginEmbedder, PluginModel } from "./context";
import type { EventPublisher } from "./events";
import {
  destinationSchema,
  actorSchema,
  nonBlankStringSchema,
  sourceSchema,
} from "./schemas";
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
    /** User linked to the Actor, when known. */
    actorUserId: z.string().min(1).optional(),
    completedAtMs: z.number().finite(),
    conversationId: z.string().min(1),
    destination: destinationSchema,
    /** Location associated with this Conversation. */
    locationId: z.string().min(1).optional(),
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
  events: PluginConversationEvents;
  id: string;
  model: PluginModel;
  name: string;
  run: {
    load(): Promise<PluginRunContext>;
  };
  state: PluginState;
  /** Events that this plugin emitted in the completed Turn, oldest first. */
  turnEvents: PluginTurnEventReader;
}

/** Task that Junior runs after each completed session. */
export interface PluginSessionTaskDefinition {
  payload?: undefined;
  run(ctx: PluginTaskContext): Promise<void> | void;
}

/** Runtime context passed to one attempt of a task that `tasks.start` started. */
export interface PluginStartedTaskContext<
  Payload = unknown,
> extends PluginContext {
  annotations: PluginConversationAnnotations;
  codeChanges: PluginCodeChanges;
  conversationChanges: PluginConversationChanges;
  /** Publishes the plugin's Events, as the heartbeat and routes do. */
  events: EventPublisher;
  /**
   * True on the last delivery that Junior makes. An attempt that throws
   * now is not run again, so a task that waits for a provider can write
   * its fallback instead.
   */
  lastDelivery: boolean;
  name: string;
  /** The payload from `tasks.start`, parsed with the task's `payload` schema. */
  payload: Payload;
  state: PluginState;
}

/**
 * Task that runs only when the plugin starts it with `tasks.start`. Junior
 * sends the payload as JSON in the queue message and parses it with
 * `payload` before each attempt. A failed attempt runs again later, a
 * bounded number of times.
 */
export interface PluginStartedTaskDefinition<
  Schema extends z.ZodType = z.ZodType,
> {
  payload: Schema;
  run(ctx: PluginStartedTaskContext<z.output<Schema>>): Promise<void> | void;
}

/** Plugin task handler registered by name in a plugin manifest module. */
export type PluginTaskDefinition =
  | PluginSessionTaskDefinition
  | PluginStartedTaskDefinition;

/** Task handlers keyed by the plugin-owned task name. */
export type PluginTasks = Record<string, PluginTaskDefinition>;

/** Input of `tasks.start`. */
export const pluginTaskStartInputSchema = z
  .object({
    /**
     * One task per plugin and key while the queue keeps the message. A
     * second start with the key in that time does nothing.
     */
    key: nonBlankStringSchema.max(500),
    /** Name of a task with a `payload` schema in this plugin's `tasks`. */
    name: nonBlankStringSchema,
    /** Seconds before the first attempt. Without it, the task runs soon. */
    delaySeconds: z.number().int().positive().optional(),
    /** JSON value that the task's `payload` schema accepts. */
    payload: z.unknown(),
  })
  .strict();

export type PluginTaskStartInput = z.output<typeof pluginTaskStartInputSchema>;

/** Starts this plugin's tasks on the plugin task queue. */
export interface PluginTaskStarter {
  start(input: PluginTaskStartInput): Promise<void>;
}
