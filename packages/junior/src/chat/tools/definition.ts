import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { Static, TSchema } from "@sinclair/typebox";
import type { ToolExecutionMode } from "@mariozechner/pi-agent-core";

export interface ToolDefinition<TInputSchema extends TSchema = TSchema> {
  description: string;
  inputSchema: TInputSchema;
  annotations?: ToolAnnotations;
  promptSnippet?: string;
  promptGuidelines?: string[];
  prepareArguments?: (args: unknown) => Static<TInputSchema>;
  executionMode?: ToolExecutionMode;
  execute?: (
    input: Static<TInputSchema>,
    options: { experimental_context?: unknown },
  ) => Promise<unknown> | unknown;
}

/** Infer execute parameter types from the inputSchema via generic binding. */
export function tool<TInputSchema extends TSchema>(
  definition: ToolDefinition<TInputSchema>,
): ToolDefinition<TInputSchema> {
  return definition;
}
