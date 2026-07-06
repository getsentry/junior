import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { AnyToolDefinition } from "@/chat/tools/definition";
import { tool } from "@/chat/tools/definition";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";

export const EXECUTE_TOOL_NAME = "executeTool";

export interface DeferredToolCall {
  arguments: Record<string, unknown>;
  definition: AnyToolDefinition;
  toolName: string;
}

function schemaErrorText(
  definition: AnyToolDefinition,
  value: unknown,
): string {
  const firstError = [...Value.Errors(definition.inputSchema, value)][0];
  if (!firstError) {
    return "invalid arguments";
  }
  return `${firstError.path || "/"} ${firstError.message}`;
}

/** Create the model-visible dispatcher schema for deferred tools. */
export function createExecuteToolTool() {
  return tool({
    description:
      "Execute a deferred tool by exact tool_name from searchTools. Put tool-specific parameters inside arguments. This can only call deferred tools returned by searchTools.",
    executionMode: "sequential",
    inputSchema: Type.Object(
      {
        tool_name: Type.String({
          minLength: 1,
          description: "Exact deferred tool_name returned by searchTools.",
        }),
        arguments: Type.Optional(
          Type.Record(Type.String(), Type.Unknown(), {
            description:
              'Arguments matching the deferred tool schema, for example { "query": "..." }.',
          }),
        ),
      },
      { additionalProperties: false },
    ),
    execute: async () => {
      throw new ToolInputError(
        "executeTool can only run through the agent tool dispatcher.",
      );
    },
  });
}

/** Resolve and validate a deferred executeTool request at runtime. */
export function resolveDeferredToolCall(
  input: Record<string, unknown>,
  deferredTools: Record<string, AnyToolDefinition>,
): DeferredToolCall {
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
    throw new ToolInputError("executeTool requires a deferred tool_name.");
  }

  const definition = deferredTools[toolName];
  if (!definition) {
    throw new ToolInputError(
      `executeTool can only call deferred tools returned by searchTools: ${toolName}`,
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

/** Apply a deferred tool's own argument preparation and schema boundary. */
export function prepareDeferredToolCall(
  call: DeferredToolCall,
): DeferredToolCall {
  const prepared = call.definition.prepareArguments
    ? call.definition.prepareArguments(call.arguments)
    : call.arguments;
  if (!Value.Check(call.definition.inputSchema, prepared)) {
    throw new ToolInputError(
      `executeTool arguments do not match schema for ${call.toolName}: ${schemaErrorText(call.definition, prepared)}`,
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
