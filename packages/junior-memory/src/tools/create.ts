import {
  definePluginTool,
  PluginToolInputError,
} from "@sentry/junior-plugin-api";
import { parseCreateMemoryRequest, parseMemoryReview } from "../agent";
import {
  type MemoryCreateToolContext,
  asToolInputError,
  compactMemory,
  createInput,
  createMemoryInputSchema,
  memoryCreateOutputSchema,
  memoryRuntimeContext,
  memoryStore,
  memoryToolResult,
  parseExpiresAt,
  parseMemoryToolInput,
  requireMemoryContent,
  requireToolCallId,
  targetForKind,
} from "../tool-support";

/** Submit an explicit memory candidate for storage. */
export const memoryCreateTool = definePluginTool({
  approvalMode: "approve",
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
        throw new PluginToolInputError(`Memory agent review failed${detail}`, {
          cause: error,
        });
      }
    })();
    if (review.decision === "reject") {
      throw new PluginToolInputError(`Memory was not stored: ${review.reason}`);
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
