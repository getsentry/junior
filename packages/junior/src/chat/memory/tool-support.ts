/** Shared context, results, and checks of the memory tools. */
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
  PluginToolInputError,
  type PluginToolOutput,
  type Source,
  type Actor,
  type Identity,
  type User,
  pluginToolOutputSchema,
} from "@sentry/junior-plugin-api";
import * as z from "zod";
import {
  createMemoryStore,
  type MemoryEmbeddingProvider,
  type MemoryDb,
  type MemoryRecord,
  type MemorySupersessionDecider,
} from "./store";
import type { MemoryAgent } from "./agent";
import { memoryRuntimeContextSchema, type MemoryRuntimeContext } from "./types";

/** The memory agent call that reviews an explicit memory candidate. */
export type MemoryReviewer = Pick<MemoryAgent, "reviewCreateRequest">;

const KNOWN_TOOL_INPUT_ERROR_MESSAGES = new Set([
  "Conversation memory requires conversation context.",
  "Conversation-subject memory requires conversation context.",
  "Memory content is required.",
  "Memory content exceeds the maximum length.",
  "Memory id is required.",
  "Memory was not found in the current context.",
  "Memory id prefix is ambiguous.",
  "User memory requires a User.",
]);

/** Runtime-owned context used to bind memory tools to visible scopes. */
export interface MemoryToolContext {
  agent: MemoryReviewer;
  conversationId?: string;
  db: MemoryDb;
  embedder?: MemoryEmbeddingProvider;
  locationId?: string;
  actor?: Actor;
  source: Source;
  users: {
    resolveActor(): Promise<{ identity: Identity; user?: User } | undefined>;
  };
  userText?: string;
}

/** Memory tool context with the decider for superseded memories. */
export interface MemoryCreateToolContext extends MemoryToolContext {
  supersessionDecider?: MemorySupersessionDecider;
}

/** Throw a model-repairable memory tool error. */
export function throwToolInputError(message: string): never {
  throw new PluginToolInputError(message);
}

/** Rethrow a known memory input failure as a model-repairable error. */
export function asToolInputError(error: unknown): never {
  if (error instanceof PluginToolInputError) {
    throw error;
  }
  if (
    error instanceof Error &&
    KNOWN_TOOL_INPUT_ERROR_MESSAGES.has(error.message)
  ) {
    throw new PluginToolInputError(error.message, { cause: error });
  }
  throw error;
}

/** Build the memory runtime context of the current tool call. */
export async function memoryRuntimeContext(
  context: MemoryToolContext,
): Promise<MemoryRuntimeContext> {
  const actorUser = (await context.users.resolveActor())?.user;
  return memoryRuntimeContextSchema.parse({
    ...(context.conversationId
      ? { conversationId: context.conversationId }
      : undefined),
    ...(context.actor ? { actor: context.actor } : undefined),
    ...(context.locationId ? { locationId: context.locationId } : undefined),
    source: context.source,
    ...(actorUser ? { userId: actorUser.id } : undefined),
  });
}

/** Open the memory store for the tool call's visible scopes. */
export function memoryStore(
  context: MemoryToolContext,
  runtimeContext: MemoryRuntimeContext,
  options: { supersessionDecider?: MemorySupersessionDecider | undefined } = {},
) {
  return createMemoryStore(context.db, runtimeContext, {
    embedder: context.embedder,
    ...(options.supersessionDecider
      ? { supersessionDecider: options.supersessionDecider }
      : undefined),
  });
}

/** Clamp a requested result limit to 1-50. */
export function boundedLimit(
  value: number | undefined,
  fallback: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(50, Math.max(1, Math.floor(value)));
}

/** Require non-blank memory content. */
export function requireMemoryContent(value: string): string {
  if (value.trim().length === 0) {
    throwToolInputError("Memory content is required.");
  }
  return value;
}

const memoryToolProjectionSchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    content: Type.String({ minLength: 1 }),
    created_at: Type.String(),
    observed_at: Type.String(),
    expires_at: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);
type MemoryToolProjection = Static<typeof memoryToolProjectionSchema>;

type MemoryStructuredToolResult<TData extends Record<string, unknown>> =
  PluginToolOutput &
    TData & {
      target: string;
    };

/** Model-visible fields of one memory in a tool result. */
export const memoryProjectionOutputSchema = z.object({
  id: z.string(),
  content: z.string(),
  created_at: z.string(),
  observed_at: z.string(),
  expires_at: z.string().optional(),
});

/** Result of a tool that returns one memory. */
export const memorySingleOutputSchema = pluginToolOutputSchema.extend({
  target: z.string(),
  memory: memoryProjectionOutputSchema,
});

/** Result of a tool that returns a list of memories. */
export const memoryManyOutputSchema = pluginToolOutputSchema.extend({
  target: z.string(),
  memories: z.array(memoryProjectionOutputSchema),
});

/** Parse memory tool input, as a model-repairable error when invalid. */
export function parseMemoryToolInput<T>(
  schema: z.ZodType<T>,
  input: unknown,
): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new PluginToolInputError("Invalid memory tool input.", {
      cause: result.error,
    });
  }
  return result.data;
}

/** Return the model-visible projection without hidden ownership/source fields. */
export function compactMemory(memory: MemoryRecord): MemoryToolProjection {
  return Value.Parse(memoryToolProjectionSchema, {
    id: memory.id,
    content: memory.content,
    created_at: new Date(memory.createdAtMs).toISOString(),
    observed_at: new Date(memory.observedAtMs).toISOString(),
    ...(memory.expiresAtMs !== undefined
      ? { expires_at: new Date(memory.expiresAtMs).toISOString() }
      : undefined),
  });
}

/** Build a memory tool result for one target. */
export function memoryToolResult<TData extends Record<string, unknown>>(
  target: string,
  data: TData,
): MemoryStructuredToolResult<TData> {
  return {
    target,
    ...data,
  };
}
