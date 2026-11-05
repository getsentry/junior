import { z } from "zod";
import type { User } from "./context";

const conversationEventNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_]*$/);

export const conversationEventIconSchema = z.enum([
  "activity",
  "brain",
  "calendar",
  "check",
  "database",
  "info",
  "key",
  "link",
  "sparkles",
  "warning",
]);

const conversationEventDetailSchema = z
  .object({
    content: z
      .string()
      .min(1)
      .max(32 * 1024)
      .optional(),
    description: z.string().trim().min(1).max(2_000).optional(),
    metadata: z.array(z.string().trim().min(1).max(120)).max(8).optional(),
    title: z.string().trim().min(1).max(4_000),
  })
  .strict();

/** Safe, core-rendered presentation for one plugin conversation event. */
export const conversationEventPresentationSchema = z
  .object({
    details: z.array(conversationEventDetailSchema).max(100).optional(),
    icon: conversationEventIconSchema.optional(),
    preview: z.string().trim().min(1).max(500).optional(),
    title: z.string().trim().min(1).max(120),
  })
  .strict();

export type ConversationEventPresentation = z.output<
  typeof conversationEventPresentationSchema
>;

/** One validated plugin event value waiting for conversation-bound emission. */
export interface PluginConversationEventValue {
  readonly data: Record<string, unknown>;
  readonly definition: PluginConversationEventDefinition;
}

/** Registered schema and optional transcript presentation for one event version. */
export interface PluginConversationEventDefinition {
  readonly eventName: string;
  readonly version: number;
  parse(data: unknown): Record<string, unknown>;
  renderEvent(
    data: Record<string, unknown>,
  ): ConversationEventPresentation | undefined;
}

/** Typed factory returned while authoring one plugin conversation event. */
export interface DefinedConversationEvent<
  TInput,
> extends PluginConversationEventDefinition {
  (data: TInput): PluginConversationEventValue;
}

/** Define one typed, versioned plugin-owned conversation event. */
export function defineConversationEvent<
  TSchema extends z.ZodType<Record<string, unknown>>,
>(definition: {
  name: string;
  version: number;
  schema: TSchema;
  renderEvent(
    event: z.output<TSchema>,
  ): z.input<typeof conversationEventPresentationSchema> | undefined;
}): DefinedConversationEvent<z.input<TSchema>> {
  const identity = z
    .object({
      name: conversationEventNameSchema,
      version: z.number().int().positive(),
    })
    .strict()
    .parse({ name: definition.name, version: definition.version });
  let eventDefinition: DefinedConversationEvent<z.input<TSchema>>;
  const createEvent = (
    data: z.input<TSchema>,
  ): PluginConversationEventValue => ({
    data: definition.schema.parse(data),
    definition: eventDefinition,
  });
  eventDefinition = Object.assign(createEvent, {
    eventName: identity.name,
    version: identity.version,
    parse(data: unknown) {
      return definition.schema.parse(data);
    },
    renderEvent(data: Record<string, unknown>) {
      const parsed = definition.schema.parse(data);
      const presentation = definition.renderEvent(parsed);
      return presentation === undefined
        ? undefined
        : conversationEventPresentationSchema.parse(presentation);
    },
  });
  return eventDefinition;
}

/** Conversation-bound event writer supplied by Junior core. */
export interface PluginConversationEvents {
  emit(event: PluginConversationEventValue): Promise<void>;
}

export interface PluginConversationEventCostDay {
  costUsd: number;
  date: string;
  events: number;
}

export interface PluginConversationEventRecord {
  content: Record<string, unknown>;
  createdAt: string;
  /** Turn that emitted the event. Events from outside a Turn have none. */
  turnId?: string;
  version: number;
}

/** Read events owned by the current plugin namespace after Conversation access checks. */
export interface PluginConversationEventReader {
  list(input: {
    conversationId: string;
    eventName: string;
    viewer: User;
  }): Promise<PluginConversationEventRecord[] | undefined>;
}

/**
 * Events that Junior writes in a plugin's namespace for the cost of each
 * priced `model`, `decider`, `embedder`, or `reranker` call in a
 * Conversation, by the context that made the call. Junior counts them in
 * Conversation cost, so plugin events must not repeat that cost. A plugin
 * cannot register these names. It can read their costs through
 * `PluginConversationEventStats`.
 */
export const pluginModelCostEventNames = {
  afterToolExecute: "after_tool_execute_model_called",
  task: "task_model_called",
  tool: "tool_model_called",
  userPrompt: "user_prompt_model_called",
} as const;

/** Whether an event name is one of `pluginModelCostEventNames`. */
export function isPluginModelCostEventName(eventName: string): boolean {
  return (Object.values(pluginModelCostEventNames) as string[]).includes(
    eventName,
  );
}

/**
 * Read aggregate costs for events owned by the current plugin namespace:
 * registered events and `pluginModelCostEventNames`.
 */
export interface PluginConversationEventStats {
  costsByDay(input: {
    days: 7 | 30 | 90;
    eventName: string;
  }): Promise<PluginConversationEventCostDay[]>;
  costsByHour(input: {
    eventName: string;
    hours?: number;
  }): Promise<PluginConversationEventCostDay[]>;
}
