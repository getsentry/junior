import { Value } from "@sinclair/typebox/value";
import * as z from "zod";
import { nestedArgumentsErrorMap } from "@/chat/tool-support/dispatcher-envelope";
import type { TSchema } from "@sinclair/typebox";
import {
  isTypeBoxInputSchema,
  type AnyToolDefinition,
} from "@/chat/tool-support/definition";
import { ToolInputError } from "@/chat/tool-support/tool-input-error";
import { parseToolInput } from "@/chat/tool-support/zod-tool";
import {
  findToolNameHint,
  ToolNameMissError,
} from "@/chat/tool-support/tool-name-suggestions";

export const EXECUTE_TOOL_NAME = "executeTool";
const MISSING_TOOL_NAME_ERROR = "executeTool requires a catalog tool_name";

/** Input envelope of `executeTool`, which the dispatcher parses before it runs the catalog tool. */
export const executeToolInputSchema = z
  .object(
    {
      tool_name: z
        .string({ error: MISSING_TOOL_NAME_ERROR })
        .min(1, { error: MISSING_TOOL_NAME_ERROR })
        .describe(
          "Exact catalog tool_name, from searchTools or as named by a skill, tool result, or error.",
        ),
      arguments: z
        .record(z.string(), z.unknown(), {
          error: "executeTool arguments must be an object when provided",
        })
        .describe(
          'Arguments matching the selected catalog tool schema, for example { "query": "..." }.',
        )
        .optional(),
      // `intent` keeps one envelope with callMcpTool. Catalog tool auth
      // prompts use the user's message as the reason, so it is dropped.
      intent: z
        .string()
        .min(1)
        .describe(
          "Optional short purpose of this call. It is not passed to the catalog tool.",
        )
        .optional(),
    },
    { error: nestedArgumentsErrorMap(EXECUTE_TOOL_NAME) },
  )
  .strict();

export interface CatalogToolCall {
  arguments: Record<string, unknown>;
  definition: AnyToolDefinition;
  toolName: string;
}

function schemaErrorText(schema: TSchema, value: unknown): string {
  const firstError = [...Value.Errors(schema, value)][0];
  if (!firstError) {
    return "invalid arguments";
  }
  return `${firstError.path || "/"} ${firstError.message}`;
}

/** Parse an executeTool envelope and resolve the catalog tool that it names. */
export function resolveCatalogToolCall(
  input: unknown,
  catalogTools: Record<string, AnyToolDefinition>,
): CatalogToolCall {
  const { tool_name: toolName, arguments: args = {} } = parseToolInput(
    executeToolInputSchema,
    input,
  );
  const definition = catalogTools[toolName];
  if (!definition) {
    throw new ToolNameMissError(
      `executeTool can only call catalog tools returned by searchTools: ${toolName}.`,
      findToolNameHint(toolName, catalogTools),
    );
  }
  return { arguments: args, definition, toolName };
}

/**
 * Apply a tool's own argument preparation and schema boundary to a call that
 * a dispatcher (`executeTool` or a Code Mode script) makes for the model.
 */
export function prepareCatalogToolCall(
  call: CatalogToolCall,
  dispatcherName = "executeTool",
): CatalogToolCall {
  const prepared = call.definition.prepareArguments
    ? call.definition.prepareArguments(call.arguments)
    : call.arguments;
  if (
    isTypeBoxInputSchema(call.definition.inputSchema) &&
    !Value.Check(call.definition.inputSchema, prepared)
  ) {
    throw new ToolInputError(
      `${dispatcherName} arguments do not match schema for ${call.toolName}: ${schemaErrorText(call.definition.inputSchema, prepared)}`,
    );
  }
  if (!prepared || typeof prepared !== "object" || Array.isArray(prepared)) {
    throw new ToolInputError(
      `${dispatcherName} arguments must prepare to an object for ${call.toolName}.`,
    );
  }
  return {
    arguments: prepared as Record<string, unknown>,
    definition: call.definition,
    toolName: call.toolName,
  };
}
