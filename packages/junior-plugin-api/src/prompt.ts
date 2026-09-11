import { z } from "zod";
import type {
  Destination,
  Platform,
  PluginContext,
  PluginEmbedder,
  PluginModel,
  Actor,
  Identity,
  Source,
  User,
} from "./context";
import type { PluginState } from "./state";
import type { PluginConversationEvents } from "./conversation-events";

const promptContextKindSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_-]*$/);

export const promptMessageSchema = z
  .object({
    text: z.string().trim().min(1).max(8_000),
  })
  .strict();

/** Small plugin-owned prompt text block rendered by Junior core. */
export type PromptMessage = z.output<typeof promptMessageSchema>;

export const promptContextSchema = z
  .object({
    kind: promptContextKindSchema,
    version: z.number().int().positive(),
    content: z.record(z.string(), z.unknown()),
  })
  .strict();

/** Structured plugin context retained alongside its model-visible rendering. */
export type PromptContext = z.output<typeof promptContextSchema>;

/** Runtime contribution produced from one validated plugin context value. */
export interface PromptContextContribution {
  context: PromptContext;
  renderPrompt(): string;
}

/** Define one typed, versioned plugin context contribution. */
export function definePromptContext<
  TSchema extends z.ZodType<Record<string, unknown>>,
>(definition: {
  kind: string;
  version: number;
  schema: TSchema;
  renderPrompt(content: z.output<TSchema>): string;
}): (content: z.input<TSchema>) => PromptContextContribution {
  const identity = promptContextSchema
    .pick({ kind: true, version: true })
    .parse({ kind: definition.kind, version: definition.version });
  return (content) => {
    const parsed = definition.schema.parse(content);
    return {
      context: { ...identity, content: parsed },
      renderPrompt: () => definition.renderPrompt(parsed),
    };
  };
}

/** One request-scoped plugin contribution to the model-visible user prompt. */
export type UserPromptContribution = PromptMessage | PromptContextContribution;

export const pluginBriefLineSchema = z.string().trim().min(1).max(400);
export const pluginBriefSummarySchema = z.string().trim().min(1).max(600);
export const pluginBriefOutcomeStatusSchema = z.enum([
  "in_progress",
  "answered",
  "done",
  "partial",
  "blocked",
  "abandoned",
]);
export const pluginBriefDecisionKindSchema = z.enum([
  "stated",
  "confirmed",
  "assumed",
]);

export const pluginBriefSchema = z
  .object({
    conversationId: z.string().min(1),
    summary: pluginBriefSummarySchema,
    outcome: z
      .object({
        status: pluginBriefOutcomeStatusSchema,
        text: pluginBriefSummarySchema,
      })
      .strict(),
    decisions: z
      .array(
        z
          .object({
            kind: pluginBriefDecisionKindSchema,
            text: pluginBriefLineSchema,
          })
          .strict(),
      )
      .max(20),
    links: z
      .array(
        z
          .object({
            label: pluginBriefLineSchema,
            url: z.string().url().max(2_048),
            status: pluginBriefLineSchema.optional(),
          })
          .strict(),
      )
      .max(40),
    updatedAt: z.string().datetime(),
  })
  .strict();

/** Public Brief fields that a plugin can add to prompt context. */
export type PluginBrief = z.output<typeof pluginBriefSchema>;

/** Stable platform context for plugin system prompt guidance. */
export type SystemPromptContext = Pick<
  PluginContext,
  "db" | "log" | "plugin"
> & {
  platform: Platform;
};

/** Runtime facts available while building plugin user prompt context. */
export type UserPromptContext = Pick<PluginContext, "db" | "log" | "plugin"> & {
  conversationId?: string;
  briefs: {
    /** Read the latest Briefs for authorized public root Conversations. */
    readLatest(
      conversationIds: readonly string[],
    ): Promise<Record<string, PluginBrief>>;
  };
  destination: Destination;
  embedder: PluginEmbedder;
  /** Conversation-bound event writer when the prompt belongs to a durable turn. */
  events?: PluginConversationEvents;
  model: PluginModel;
  /** Location associated with this Conversation. */
  locationId?: string;
  actor?: Actor;
  source: Source;
  state: PluginState;
  text: string;
  users: {
    /** Resolve the current Actor's Identity and User. */
    resolveActor(): Promise<{ identity: Identity; user?: User } | undefined>;
  };
};
