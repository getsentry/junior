import { Type } from "@sinclair/typebox";
import {
  PluginToolInputError,
  type PluginDb,
  type PluginToolDefinition,
  type Source,
  type Requester,
} from "@sentry/junior-plugin-api";
import {
  createMemoryStore,
  type CreateMemoryInput,
  type MemoryRecord,
} from "./store";
import type { MemoryRuntimeContext } from "./types";

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
  "Personal memory requires requester context.",
  "User-subject memory requires requester context.",
]);

/** Runtime-owned context used to bind memory tools to visible scopes. */
export interface MemoryToolContext {
  conversationId?: string;
  db: PluginDb;
  requester?: Requester;
  source: Source;
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
  return {
    ...(context.conversationId
      ? { conversationId: context.conversationId }
      : {}),
    ...(context.requester ? { requester: context.requester } : {}),
    source: context.source,
  } as MemoryRuntimeContext;
}

function memoryStore(context: MemoryToolContext) {
  return createMemoryStore(context.db, memoryRuntimeContext(context));
}

function boundedLimit(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(50, Math.max(1, Math.floor(value)));
}

function parseExpiresAt(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const expiresAtMs = Date.parse(value);
  if (!Number.isFinite(expiresAtMs)) {
    throwToolInputError("expires_at must be a valid ISO timestamp.");
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

type MemoryWriteToolInput = {
  content: string;
  expires_at?: string;
};

function createInput(input: MemoryWriteToolInput, toolCallId: string) {
  return {
    content: requireMemoryContent(input.content),
    idempotencyKey: `tool:${toolCallId}`,
    ...(input.expires_at
      ? { expiresAtMs: parseExpiresAt(input.expires_at) }
      : {}),
  } satisfies CreateMemoryInput;
}

/** Return the model-visible projection without hidden ownership/source fields. */
function compactMemory(memory: MemoryRecord) {
  return {
    id: memory.id,
    scope: memory.scope,
    content: memory.content,
    createdAtMs: memory.createdAtMs,
    ...(memory.expiresAtMs !== undefined
      ? { expiresAtMs: memory.expiresAtMs }
      : {}),
  };
}

/** Create a tool that submits an explicit memory candidate for storage. */
export function createMemoryCreateTool(context: MemoryToolContext) {
  return {
    description:
      "Remember a public/shareable fact about the current requester for later. Use only when the requester explicitly asks Junior to remember something about themselves. Pass one self-contained memory candidate; include the requester as the subject in the content itself when needed, such as 'The requester prefers terse updates'. Do not pass vague references like 'remember this'. Do not include secrets, private personal details, medical/legal/financial/sensitive facts, or facts about another person's private life. Runtime context derives all actor ids, Slack ids, scope keys, source ids, and subject ids.",
    executionMode: "sequential",
    inputSchema: Type.Object(
      {
        content: Type.String({
          minLength: 1,
          maxLength: MAX_TOOL_CONTENT_CHARS,
          description:
            "Self-contained public/shareable memory candidate. Include the subject in natural language when it matters; do not rely on surrounding chat context.",
        }),
        expires_at: Type.Optional(
          Type.String({
            minLength: 1,
            description:
              "Optional exact ISO timestamp when this memory should expire.",
          }),
        ),
      },
      { additionalProperties: false },
    ),
    execute: async (input, options) => {
      const store = memoryStore(context);
      const memoryInput = createInput(
        input,
        requireToolCallId(options.toolCallId),
      );
      const result = await (async () => {
        try {
          return await store.createMemory(memoryInput);
        } catch (error) {
          asToolInputError(error);
        }
      })();
      return {
        ok: true,
        created: result.created,
        memory: compactMemory(result.memory),
      };
    },
  } satisfies PluginToolDefinition<MemoryWriteToolInput>;
}

/** Create a tool that archives a visible memory in the active context. */
export function createMemoryRemoveTool(context: MemoryToolContext) {
  return {
    description:
      "Forget one memory visible in the active context. Use only ids or short id prefixes returned by listMemories or searchMemories. Never remove memories by hidden actor, Slack, scope, or subject identifiers.",
    executionMode: "sequential",
    inputSchema: Type.Object(
      {
        id: Type.String({
          minLength: 1,
          description: "Memory id or unambiguous short id prefix to remove.",
        }),
      },
      { additionalProperties: false },
    ),
    execute: async (input) => {
      const memory = await (async () => {
        try {
          return await memoryStore(context).archiveMemory({
            id: input.id,
            reason: "tool_removed",
          });
        } catch (error) {
          asToolInputError(error);
        }
      })();
      return {
        ok: true,
        memory: compactMemory(memory),
      };
    },
  } satisfies PluginToolDefinition<{ id: string }>;
}

/** Create a tool that lists visible active memories in the active context. */
export function createMemoryListTool(context: MemoryToolContext) {
  return {
    description:
      "List active memories visible in the current context. Use when the user asks what Junior remembers or when memory ids are needed before removing a memory.",
    annotations: { readOnlyHint: true, destructiveHint: false },
    inputSchema: Type.Object(
      {
        limit: Type.Optional(
          Type.Number({
            minimum: 1,
            maximum: 50,
            description: "Maximum number of visible memories to return.",
          }),
        ),
      },
      { additionalProperties: false },
    ),
    execute: async (input) => {
      const memories = await memoryStore(context).listMemories({
        limit: boundedLimit(input.limit, DEFAULT_RESULT_LIMIT),
      });
      return {
        ok: true,
        memories: memories.map(compactMemory),
      };
    },
  } satisfies PluginToolDefinition<{ limit?: number }>;
}

/** Create a tool that searches visible active memories in the active context. */
export function createMemorySearchTool(context: MemoryToolContext) {
  return {
    description:
      "Search active memories visible in the current context. Use when the model needs targeted memory recall. The tool searches only the current requester and active conversation scopes.",
    annotations: { readOnlyHint: true, destructiveHint: false },
    inputSchema: Type.Object(
      {
        query: Type.String({
          minLength: 1,
          description: "Search query for visible memory content.",
        }),
        limit: Type.Optional(
          Type.Number({
            minimum: 1,
            maximum: 50,
            description: "Maximum number of matching memories to return.",
          }),
        ),
      },
      { additionalProperties: false },
    ),
    execute: async (input) => {
      const memories = await memoryStore(context).searchMemories({
        query: input.query,
        limit: boundedLimit(input.limit, DEFAULT_SEARCH_LIMIT),
      });
      return {
        ok: true,
        memories: memories.map(compactMemory),
      };
    },
  } satisfies PluginToolDefinition<{ limit?: number; query: string }>;
}
