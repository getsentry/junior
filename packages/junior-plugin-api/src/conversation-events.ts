import { z } from "zod";

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

/** Read aggregate costs for events owned by the current plugin namespace. */
export interface PluginConversationEventStats {
  costsByDay(input: {
    days: 7 | 30 | 90;
    eventName: string;
  }): Promise<PluginConversationEventCostDay[]>;
}
