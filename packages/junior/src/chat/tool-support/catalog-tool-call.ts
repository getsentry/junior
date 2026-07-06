import { Value } from "@sinclair/typebox/value";
import type { TSchema } from "@sinclair/typebox";
import {
  isTypeBoxInputSchema,
  type AnyToolDefinition,
} from "@/chat/tools/definition";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";

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

/** Resolve and validate a catalog executeTool request at runtime. */
export function resolveCatalogToolCall(
  input: Record<string, unknown>,
  catalogTools: Record<string, AnyToolDefinition>,
): CatalogToolCall {
  const extraKeys = Object.keys(input).filter(
    (key) => key !== "tool_name" && key !== "arguments",
  );
  if (extraKeys.length > 0) {
    throw new ToolInputError(
      `executeTool arguments must be nested under arguments, not top-level fields: ${extraKeys.join(", ")}`,
    );
  }

  const toolName = input.tool_name;
  if (typeof toolName !== "string" || toolName.length === 0) {
    throw new ToolInputError("executeTool requires a catalog tool_name.");
  }

  const definition = catalogTools[toolName];
  if (!definition) {
    throw new ToolInputError(
      `executeTool can only call catalog tools returned by searchTools: ${toolName}`,
    );
  }

  const args = input.arguments;
  if (args === undefined) {
    return { arguments: {}, definition, toolName };
  }
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new ToolInputError(
      "executeTool arguments must be an object when provided.",
    );
  }

  return { arguments: args as Record<string, unknown>, definition, toolName };
}

/** Apply a catalog tool's own argument preparation and schema boundary. */
export function prepareCatalogToolCall(call: CatalogToolCall): CatalogToolCall {
  const prepared = call.definition.prepareArguments
    ? call.definition.prepareArguments(call.arguments)
    : call.arguments;
  if (
    isTypeBoxInputSchema(call.definition.inputSchema) &&
    !Value.Check(call.definition.inputSchema, prepared)
  ) {
    throw new ToolInputError(
      `executeTool arguments do not match schema for ${call.toolName}: ${schemaErrorText(call.definition.inputSchema, prepared)}`,
    );
  }
  if (!prepared || typeof prepared !== "object" || Array.isArray(prepared)) {
    throw new ToolInputError(
      `executeTool arguments must prepare to an object for ${call.toolName}.`,
    );
  }
  return {
    arguments: prepared as Record<string, unknown>,
    definition: call.definition,
    toolName: call.toolName,
  };
}
