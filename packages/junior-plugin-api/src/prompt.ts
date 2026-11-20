import * as z from "zod";
import type {
  Destination,
  Platform,
  PluginContext,
  PluginEmbedder,
  PluginModel,
  PluginReranker,
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

/** Stable platform context for plugin system prompt guidance. */
export type SystemPromptContext = Pick<
  PluginContext,
  "db" | "log" | "plugin"
> & {
  platform: Platform;
};

/** One prompt context that this plugin gave an earlier Turn. */
export type PromptHistoryContext = PromptContext & {
  /** When the plugin made it. */
  loadedAtMs: number;
};

/** What the model history that a new prompt replays holds. */
export interface PromptHistory {
  /**
   * When this history started: the time of the last History replacement.
   * Undefined when it holds the whole Conversation.
   */
  startedAtMs?: number;
  /** This plugin's prompt contexts in this history, oldest first. */
  contexts: PromptHistoryContext[];
}

/** Runtime facts available while building plugin user prompt context. */
export type UserPromptContext = Pick<PluginContext, "db" | "log" | "plugin"> & {
  conversationId?: string;
  destination: Destination;
  embedder: PluginEmbedder;
  /** Conversation-bound event writer when the prompt belongs to a durable turn. */
  events?: PluginConversationEvents;
  model: PluginModel;
  /** Host reranker bound to the configured reranking model. */
  reranker: PluginReranker;
  /**
   * Record numeric diagnostics on the host span for this hook. Keys must
   * start with `app.<plugin name>.`; the host drops other keys and
   * non-finite values.
   */
  setSpanAttributes(attributes: Record<string, number>): void;
  /** Location associated with this Conversation. */
  locationId?: string | undefined;
  /**
   * Read the model history that this prompt replays, such as to skip context
   * that the model still has. Undefined when the prompt has no Conversation.
   */
  loadHistory?(): Promise<PromptHistory>;
  actor?: Actor | undefined;
  source: Source;
  state: PluginState;
  /**
   * The request of this Turn: what a person wrote, the task or message of a
   * parent agent, or the instructions of an Automation. Runtime text, such as
   * tags, generic instructions, Events, child agent results, and the question
   * of a Review item, is not in it. Empty when the Turn has no request.
   */
  text: string;
  users: {
    /** Resolve the current Actor's Identity and User. */
    resolveActor(): Promise<{ identity: Identity; user?: User } | undefined>;
  };
};
