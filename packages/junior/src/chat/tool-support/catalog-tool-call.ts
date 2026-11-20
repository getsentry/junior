import { Value } from "@sinclair/typebox/value";
import type { TSchema } from "@sinclair/typebox";
import {
  isTypeBoxInputSchema,
  type AnyToolDefinition,
} from "@/chat/tools/definition";
import { executeToolInputSchema } from "@/chat/tools/execute-tool";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";
import { parseToolInput } from "@/chat/tool-support/zod-tool";
import {
  findToolNameHint,
  renderToolNameHint,
  ToolNameMissError,
} from "@/chat/tool-support/tool-name-suggestions";

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
    // Say the next call, not only the rule: a model that gets only "Did you
    // mean" can give up instead of calling again with the suggested name.
    const hint = findToolNameHint(toolName, catalogTools);
    const hintText = renderToolNameHint(hint);
    const next = hintText
      ? `${hintText} Call executeTool again with the exact name as tool_name.`
      : "Call searchTools to find its exact name.";
    throw new ToolNameMissError(
      `\`${toolName}\` is not a catalog tool. ${next}`,
      hint,
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
