import {
  definePluginTool,
  getSourceKey,
  PluginToolInputError,
  pluginToolOutputSchema,
} from "@sentry/junior-plugin-api";
import * as z from "zod";
import type { CreateMemoryInput } from "../store";
import { parseCreateMemoryRequest, parseMemoryReview } from "../agent";
import type { MemoryKind } from "../types";
import {
  asToolInputError,
  compactMemory,
  memoryProjectionOutputSchema,
  memoryRuntimeContext,
  memoryStore,
  memoryToolResult,
  parseMemoryToolInput,
  requireMemoryContent,
  throwToolInputError,
  type MemoryCreateToolContext,
  type MemoryToolContext,
} from "../tool-support";

const MAX_TOOL_CONTENT_CHARS = 4_000;

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

const createMemoryInputSchema = z
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

const memoryCreateOutputSchema = pluginToolOutputSchema.extend({
  target: z.string(),
  created: z.boolean(),
  memory: memoryProjectionOutputSchema,
});

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
      : undefined),
  } satisfies CreateMemoryInput;
}

function targetForKind(kind: MemoryKind): "actor" | "conversation" {
  if (kind === "preference") {
    return "actor";
  }
  return "conversation";
}

/** Submit an explicit memory candidate for storage. */
export const memoryCreateTool = definePluginTool({
  guardian: { permission: "allow" },
  annotations: {
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
    readOnlyHint: false,
  },
  description:
    "Explicit memory-write tool. Use only when the latest user message directly asks you to remember, store, save, or forget-and-replace a fact. Do not use for ordinary statements like 'I prefer X', 'I use Y', or 'X goes before Y' unless the user also asks you to remember/store/save it; passive memory learning handles those after the visible reply. Pass one self-contained natural-language candidate preserving the user's explicit memory intent. Do not ask the user to rephrase ordinary first-person facts, and do not rewrite them into display-name or third-person wording. Do not include secrets, private personal details, medical/legal/financial/sensitive facts, or another person's personal preference, opinion, habit, identity, relationship, workflow, or private life. The runtime sets access, Location, Source, and subject. The memory agent rewrites the content and sets the memory kind.",
  executionMode: "sequential",
  inputSchema: createMemoryInputSchema,
  outputSchema: memoryCreateOutputSchema,
  execute: async (input, options, context: MemoryCreateToolContext) => {
    const parsedInput = parseMemoryToolInput(createMemoryInputSchema, input);
    const toolCallId = requireToolCallId(options.toolCallId);
    const requestedExpiresAtMs = parseExpiresAt(parsedInput.expires_at);
    const runtimeContext = await memoryRuntimeContext(context);
    const store = memoryStore(context, runtimeContext, {
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
                : undefined),
              runtimeContext,
              ...(context.userText?.trim()
                ? {
                    sourceContext: {
                      currentUserText: context.userText.trim(),
                    },
                  }
                : undefined),
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
          `Memory agent review failed${detail}. Continue without storing this memory.`,
          {
            cause: error,
          },
        );
      }
    })();
    if (review.decision === "reject") {
      throw new PluginToolInputError(
        `Memory was not stored. Change the memory to fix this problem, or do not store it: ${review.reason}`,
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
