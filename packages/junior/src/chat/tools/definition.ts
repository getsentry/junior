import type { Static, TSchema } from "@sinclair/typebox";

export interface ToolDefinition<TInputSchema extends TSchema = TSchema> {
  description: string;
  inputSchema: TInputSchema;
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
