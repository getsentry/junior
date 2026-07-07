import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
  definePluginTool,
  getSourceKey,
  PluginToolInputError,
  type PluginToolResult,
  type Source,
  type Actor,
  pluginToolResultSchema,
} from "@sentry/junior-plugin-api";
import { z } from "zod";
import {
  createMemoryStore,
  type CreateMemoryInput,
  type MemoryEmbeddingProvider,
  type MemoryDb,
  type MemoryRecord,
  type MemorySupersessionDecider,
} from "./store";
import {
  parseCreateMemoryRequest,
  parseMemoryReview,
  type MemoryAgent,
} from "./agent";
import {
  memoryRuntimeContextSchema,
  type MemoryKind,
  type MemoryRuntimeContext,
} from "./types";

export type MemoryReviewer = Pick<MemoryAgent, "reviewCreateRequest">;

const MAX_TOOL_CONTENT_CHARS = 4_000;
const DEFAULT_RESULT_LIMIT = 20;
const DEFAULT_SEARCH_LIMIT = 10;

const KNOWN_TOOL_INPUT_ERROR_MESSAGES = new Set([
  "Conversation memory requires conversation context.",
  "Conversation-subject memory requires conversation context.",
  "Memory content is required.",
  "Memory content exceeds the maximum length.",
  "Memory id is required.",
  "Memory was not found in the current context.",
  "Memory id prefix is ambiguous.",
  "Personal memory requires actor context.",
  "User-subject memory requires actor context.",
]);

/** Runtime-owned context used to bind memory tools to visible scopes. */
export interface MemoryToolContext {
  agent: MemoryReviewer;
  conversationId?: string;
  db: MemoryDb;
  embedder?: MemoryEmbeddingProvider;
  actor?: Actor;
  source: Source;
  userText?: string;
}

export interface MemoryCreateToolContext extends MemoryToolContext {
  supersessionDecider?: MemorySupersessionDecider;
}

function throwToolInputError(message: string): never {
  throw new PluginToolInputError(message);
}

function asToolInputError(error: unknown): never {
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

function memoryRuntimeContext(
  context: MemoryToolContext,
): MemoryRuntimeContext {
  return memoryRuntimeContextSchema.parse({
    ...(context.conversationId
      ? { conversationId: context.conversationId }
      : {}),
    ...(context.actor ? { actor: context.actor } : {}),
    source: context.source,
  });
}

function memoryStore(
  context: MemoryToolContext,
  options: { supersessionDecider?: MemorySupersessionDecider } = {},
) {
  return createMemoryStore(context.db, memoryRuntimeContext(context), {
    embedder: context.embedder,
    ...(options.supersessionDecider
      ? { supersessionDecider: options.supersessionDecider }
      : {}),
  });
}

function boundedLimit(value: number | undefined, fallback: number): number {
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

function parseExpiresAt(value: string | undefined): number | undefined {
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

function requireToolCallId(value: string | undefined): string {
  if (!value) {
    throwToolInputError("Memory creation requires a tool call id.");
  }
  return value;
}

function requireMemoryContent(value: string): string {
  if (value.trim().length === 0) {
    throwToolInputError("Memory content is required.");
  }
  return value;
}

const createMemoryInputSchema = z
  .object({
    content: z
      .string()
      .min(1)
      .max(MAX_TOOL_CONTENT_CHARS)
      .describe(
        "Self-contained public/shareable memory candidate. Include the subject in natural language when it matters; do not rely on surrounding chat context.",
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

const removeMemoryInputSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .describe("Memory id or unambiguous short id prefix to remove."),
  })
  .strict();

const listMemoriesInputSchema = z
  .object({
    limit: z
      .number()
      .min(1)
      .max(50)
      .describe("Maximum number of visible memories to return.")
      .optional(),
  })
  .strict();

const searchMemoriesInputSchema = z
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
    createdAtMs: Type.Number(),
    observedAtMs: Type.Number(),
    expiresAtMs: Type.Optional(Type.Number()),
  },
  { additionalProperties: false },
);
type MemoryToolProjection = Static<typeof memoryToolProjectionSchema>;

type MemoryStructuredToolResult<TData extends Record<string, unknown>> =
  PluginToolResult &
    TData & {
      ok: true;
      status: "success";
      target: string;
      data: TData;
    };

const memoryProjectionOutputSchema = z.object({
  id: z.string(),
  content: z.string(),
  createdAtMs: z.number(),
  observedAtMs: z.number(),
  expiresAtMs: z.number().optional(),
});

const memoryCreateDataOutputSchema = z.object({
  created: z.boolean(),
  memory: memoryProjectionOutputSchema,
});

const memorySingleDataOutputSchema = z.object({
  memory: memoryProjectionOutputSchema,
});

const memoryManyDataOutputSchema = z.object({
  memories: z.array(memoryProjectionOutputSchema),
});

const memoryCreateOutputSchema = pluginToolResultSchema.extend({
  ok: z.literal(true),
  status: z.literal("success"),
  target: z.string(),
  data: memoryCreateDataOutputSchema,
  created: z.boolean(),
  memory: memoryProjectionOutputSchema,
});

const memorySingleOutputSchema = pluginToolResultSchema.extend({
  ok: z.literal(true),
  status: z.literal("success"),
  target: z.string(),
  data: memorySingleDataOutputSchema,
  memory: memoryProjectionOutputSchema,
});

const memoryManyOutputSchema = pluginToolResultSchema.extend({
  ok: z.literal(true),
  status: z.literal("success"),
  target: z.string(),
  data: memoryManyDataOutputSchema,
  memories: z.array(memoryProjectionOutputSchema),
});

function parseMemoryToolInput<T>(schema: z.ZodType<T>, input: unknown): T {
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

function createInput(
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
      : {}),
  } satisfies CreateMemoryInput;
}

function targetForKind(kind: MemoryKind): "actor" | "conversation" {
  if (kind === "preference") {
    return "actor";
  }
  return "conversation";
}

/** Return the model-visible projection without hidden ownership/source fields. */
function compactMemory(memory: MemoryRecord): MemoryToolProjection {
  return Value.Parse(memoryToolProjectionSchema, {
    id: memory.id,
    content: memory.content,
    createdAtMs: memory.createdAtMs,
    observedAtMs: memory.observedAtMs,
    ...(memory.expiresAtMs !== undefined
      ? { expiresAtMs: memory.expiresAtMs }
      : {}),
  });
}

function memoryToolResult<TData extends Record<string, unknown>>(
  target: string,
  data: TData,
): MemoryStructuredToolResult<TData> {
  return {
    ok: true,
    status: "success",
    target,
    data,
    ...data,
  };
}

/** Create a tool that submits an explicit memory candidate for storage. */
export function createMemoryCreateTool(context: MemoryCreateToolContext) {
  return definePluginTool({
    description:
      "Explicit memory-write tool. Use only when the latest user message directly asks Junior to remember, store, save, or forget-and-replace a public/shareable fact. Do not use for ordinary statements like 'I prefer X', 'I use Y', or 'X goes before Y' unless the user also asks you to remember/store/save it; passive memory learning handles those after the visible reply. Pass one self-contained natural-language candidate preserving the user's explicit memory intent. Do not ask the user to rephrase ordinary first-person facts, and do not rewrite them into display-name or third-person wording. Do not include secrets, private personal details, medical/legal/financial/sensitive facts, or another person's personal preference, opinion, habit, identity, relationship, workflow, or private life. Runtime context derives actor, scope, source, and subject ids; the memory agent decides canonical stored content and memory kind, then the plugin derives storage target from kind.",
    executionMode: "sequential",
    inputSchema: createMemoryInputSchema,
    outputSchema: memoryCreateOutputSchema,
    execute: async (input, options) => {
      const parsedInput = parseMemoryToolInput(createMemoryInputSchema, input);
      const toolCallId = requireToolCallId(options.toolCallId);
      const requestedExpiresAtMs = parseExpiresAt(parsedInput.expires_at);
      const runtimeContext = memoryRuntimeContext(context);
      const store = memoryStore(context, {
        supersessionDecider: context.supersessionDecider,
      });
      const review = await (async () => {
        try {
          return parseMemoryReview(
            await context.agent.reviewCreateRequest(
              parseCreateMemoryRequest({
                content: requireMemoryContent(parsedInput.content),
                ...(requestedExpiresAtMs !== undefined
                  ? { expiresAtMs: requestedExpiresAtMs }
                  : {}),
                runtimeContext,
                ...(context.userText?.trim()
                  ? {
                      sourceContext: {
                        currentUserText: context.userText.trim(),
                      },
                    }
                  : {}),
              }),
            ),
          );
        } catch (error) {
          if (error instanceof PluginToolInputError) {
            throw error;
          }
          const detail =
            error instanceof Error && error.message.trim()
              ? `: ${error.message}`
              : "";
          throw new PluginToolInputError(
            `Memory agent review failed${detail}`,
            { cause: error },
          );
        }
      })();
      if (review.decision === "reject") {
        throw new PluginToolInputError(
          `Memory was not stored: ${review.reason}`,
        );
      }
      const memoryInput = createInput(
        context,
        {
          content: review.content,
          kind: review.kind,
          ...(review.expiresAtMs !== undefined
            ? { expiresAtMs: review.expiresAtMs }
            : requestedExpiresAtMs !== undefined
              ? { expiresAtMs: requestedExpiresAtMs }
              : {}),
        },
        toolCallId,
      );
      const result = await (async () => {
        try {
          if (targetForKind(review.kind) === "conversation") {
            return await store.createConversationMemory(memoryInput);
          }
          return await store.createMemory(memoryInput);
        } catch (error) {
          asToolInputError(error);
        }
      })();
      return memoryToolResult("createMemory", {
        created: result.created,
        memory: compactMemory(result.memory),
      });
    },
  });
}

/** Create a tool that archives a visible memory in the active context. */
export function createMemoryRemoveTool(context: MemoryToolContext) {
  return definePluginTool({
    description:
      "Forget one memory visible in the active context. Use only ids or short id prefixes returned by listMemories or searchMemories. Never remove memories by hidden actor, Slack, scope, or subject identifiers.",
    executionMode: "sequential",
    inputSchema: removeMemoryInputSchema,
    outputSchema: memorySingleOutputSchema,
    execute: async (input) => {
      const parsedInput = parseMemoryToolInput(removeMemoryInputSchema, input);
      const memory = await (async () => {
        try {
          return await memoryStore(context).archiveMemory({
            id: parsedInput.id,
            reason: "tool_removed",
          });
        } catch (error) {
          asToolInputError(error);
        }
      })();
      return memoryToolResult("removeMemory", {
        memory: compactMemory(memory),
      });
    },
  });
}

/** Create a tool that lists visible active memories in the active context. */
export function createMemoryListTool(context: MemoryToolContext) {
  return definePluginTool({
    description:
      "List active memories visible in the current context. Use when the user asks what Junior remembers or when memory ids are needed before removing a memory.",
    annotations: { readOnlyHint: true, destructiveHint: false },
    inputSchema: listMemoriesInputSchema,
    outputSchema: memoryManyOutputSchema,
    execute: async (input) => {
      const parsedInput = parseMemoryToolInput(listMemoriesInputSchema, input);
      const memories = await memoryStore(context).listMemories({
        limit: boundedLimit(parsedInput.limit, DEFAULT_RESULT_LIMIT),
      });
      return memoryToolResult("listMemories", {
        memories: memories.map(compactMemory),
      });
    },
  });
}

/** Create a tool that searches visible active memories in the active context. */
export function createMemorySearchTool(context: MemoryToolContext) {
  return definePluginTool({
    description:
      "Search active memories visible in the current context. Use when the model needs targeted memory recall. The tool searches only the current actor and active conversation scopes.",
    annotations: { readOnlyHint: true, destructiveHint: false },
    inputSchema: searchMemoriesInputSchema,
    outputSchema: memoryManyOutputSchema,
    execute: async (input) => {
      const parsedInput = parseMemoryToolInput(
        searchMemoriesInputSchema,
        input,
      );
      const memories = await memoryStore(context).searchMemories({
        query: parsedInput.query,
        limit: boundedLimit(parsedInput.limit, DEFAULT_SEARCH_LIMIT),
      });
      return memoryToolResult("searchMemories", {
        memories: memories.map(compactMemory),
      });
    },
  });
}
