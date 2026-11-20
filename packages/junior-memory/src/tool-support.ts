/** Shared input, result, and store helpers of the memory tools. */
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
  getSourceKey,
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
  type CreateMemoryInput,
  type MemoryEmbeddingProvider,
  type MemoryDb,
  type MemoryRecord,
  type MemorySupersessionDecider,
} from "./store";
import type { MemoryAgent } from "./agent";
import {
  memoryRuntimeContextSchema,
  type MemoryKind,
  type MemoryRuntimeContext,
} from "./types";

export type MemoryReviewer = Pick<MemoryAgent, "reviewCreateRequest">;

const MAX_TOOL_CONTENT_CHARS = 4_000;
export const DEFAULT_RESULT_LIMIT = 20;
export const DEFAULT_SEARCH_LIMIT = 10;

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

export interface MemoryCreateToolContext extends MemoryToolContext {
  supersessionDecider?: MemorySupersessionDecider;
}

function throwToolInputError(message: string): never {
  throw new PluginToolInputError(message);
}

/** Rethrow a known memory store failure as a tool input error. */
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

/** Read the memory runtime context of a tool call. */
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

/** Create the memory store for a tool call. */
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

/** Clamp a requested result limit to the allowed range. */
export function boundedLimit(
  value: number | undefined,
  fallback: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(50, Math.max(1, Math.floor(value)));
}

function digitAt(value: string, index: number): boolean {
  const code = value.charCodeAt(index);
  return code >= 48 && code <= 57;
}

function readDigits(
  value: string,
  start: number,
  length: number,
): number | undefined {
  for (let index = start; index < start + length; index++) {
    if (!digitAt(value, index)) {
      return undefined;
    }
  }
  return Number(value.slice(start, start + length));
}

function parseIsoTimestampParts(value: string) {
  if (
    value.length < 20 ||
    value[4] !== "-" ||
    value[7] !== "-" ||
    value[10] !== "T" ||
    value[13] !== ":" ||
    value[16] !== ":"
  ) {
    return undefined;
  }
  const year = readDigits(value, 0, 4);
  const month = readDigits(value, 5, 2);
  const day = readDigits(value, 8, 2);
  const hour = readDigits(value, 11, 2);
  const minute = readDigits(value, 14, 2);
  const second = readDigits(value, 17, 2);
  if (
    year === undefined ||
    month === undefined ||
    day === undefined ||
    hour === undefined ||
    minute === undefined ||
    second === undefined
  ) {
    return undefined;
  }

  let zoneStart = 19;
  if (value[zoneStart] === ".") {
    zoneStart += 1;
    const fractionStart = zoneStart;
    while (zoneStart < value.length && digitAt(value, zoneStart)) {
      zoneStart += 1;
    }
    if (zoneStart === fractionStart) {
      return undefined;
    }
  }

  if (value[zoneStart] === "Z") {
    if (zoneStart !== value.length - 1) {
      return undefined;
    }
  } else if (value[zoneStart] === "+" || value[zoneStart] === "-") {
    if (
      zoneStart !== value.length - 6 ||
      value[zoneStart + 3] !== ":" ||
      readDigits(value, zoneStart + 1, 2) === undefined ||
      readDigits(value, zoneStart + 4, 2) === undefined
    ) {
      return undefined;
    }
  } else {
    return undefined;
  }

  return { day, hour, minute, month, second, year };
}

/** Parse an optional ISO expiry time into epoch milliseconds. */
export function parseExpiresAt(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  if (value === "never") {
    return undefined;
  }
  const parts = parseIsoTimestampParts(value);
  const expiresAtMs = Date.parse(value);
  if (!parts || !Number.isFinite(expiresAtMs)) {
    throwToolInputError('expires_at must be "never" or a valid ISO timestamp.');
  }
  const calendarDate = new Date(
    Date.UTC(parts.year, parts.month - 1, parts.day),
  );
  if (
    calendarDate.getUTCFullYear() !== parts.year ||
    calendarDate.getUTCMonth() !== parts.month - 1 ||
    calendarDate.getUTCDate() !== parts.day ||
    parts.hour > 23 ||
    parts.minute > 59 ||
    parts.second > 59
  ) {
    throwToolInputError('expires_at must be "never" or a valid ISO timestamp.');
  }
  return expiresAtMs;
}

/** Return the tool call id, or fail when the runtime did not give one. */
export function requireToolCallId(value: string | undefined): string {
  if (!value) {
    throwToolInputError("Memory creation requires a tool call id.");
  }
  return value;
}

/** Return memory content, or fail when it is blank. */
export function requireMemoryContent(value: string): string {
  if (value.trim().length === 0) {
    throwToolInputError("Memory content is required.");
  }
  return value;
}

export const createMemoryInputSchema = z
  .object({
    content: z
      .string()
      .min(1)
      .max(MAX_TOOL_CONTENT_CHARS)
      .describe(
        "Self-contained memory candidate. Include the subject in natural language when it matters; do not rely on surrounding chat context.",
      ),
    expires_at: z
      .string()
      .min(1)
      .describe(
        'Expiration selector. Omit or use "never" when the memory should not expire, or use an exact ISO timestamp such as "2027-06-21T00:00:00Z".',
      )
      .optional(),
  })
  .strict();

export const archiveMemoryInputSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .describe("Memory id or unambiguous short id prefix to remove."),
  })
  .strict();

export const restoreMemoryInputSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .describe(
        "Archived memory id or unambiguous short id prefix from listMemories with archived=true.",
      ),
  })
  .strict();

export const listMemoriesInputSchema = z
  .object({
    archived: z
      .boolean()
      .describe(
        "True lists archived memories that restoreMemory can make active, instead of active ones.",
      )
      .optional(),
    limit: z
      .number()
      .min(1)
      .max(50)
      .describe("Maximum number of visible memories to return.")
      .optional(),
  })
  .strict();

export const searchMemoriesInputSchema = z
  .object({
    query: z
      .string()
      .min(1)
      .describe("Search query for visible memory content."),
    limit: z
      .number()
      .min(1)
      .max(50)
      .describe("Maximum number of matching memories to return.")
      .optional(),
  })
  .strict();

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

const memoryProjectionOutputSchema = z.object({
  id: z.string(),
  content: z.string(),
  created_at: z.string(),
  observed_at: z.string(),
  expires_at: z.string().optional(),
});

export const memoryCreateOutputSchema = pluginToolOutputSchema.extend({
  target: z.string(),
  created: z.boolean(),
  memory: memoryProjectionOutputSchema,
});

export const memorySingleOutputSchema = pluginToolOutputSchema.extend({
  target: z.string(),
  memory: memoryProjectionOutputSchema,
});

export const memoryManyOutputSchema = pluginToolOutputSchema.extend({
  target: z.string(),
  memories: z.array(memoryProjectionOutputSchema),
});

/** Parse tool input with its schema and report problems as tool input errors. */
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

function sourceIdempotencyKey(context: MemoryToolContext): string {
  const sourceKey = getSourceKey(context.source);
  if (!sourceKey) {
    throwToolInputError("Memory creation requires source message context.");
  }
  return sourceKey;
}

/** Build the store input for a memory create request. */
export function createInput(
  context: MemoryToolContext,
  input: { content: string; expiresAtMs?: number; kind: MemoryKind },
  toolCallId: string,
) {
  return {
    content: requireMemoryContent(input.content),
    idempotencyKey: `tool:${sourceIdempotencyKey(context)}:${toolCallId}`,
    kind: input.kind,
    ...(input.expiresAtMs !== undefined
      ? { expiresAtMs: input.expiresAtMs }
      : undefined),
  } satisfies CreateMemoryInput;
}

/** Return the scope target of a memory kind. */
export function targetForKind(kind: MemoryKind): "actor" | "conversation" {
  if (kind === "preference") {
    return "actor";
  }
  return "conversation";
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

/** Build a structured memory tool result. */
export function memoryToolResult<TData extends Record<string, unknown>>(
  target: string,
  data: TData,
): MemoryStructuredToolResult<TData> {
  return {
    target,
    ...data,
  };
}
