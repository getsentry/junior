import type { z, ZodTypeAny } from "zod";

export interface ToolCallOptions {
  experimental_context?: unknown;
}

export interface ToolDefinition<TSchema extends ZodTypeAny = ZodTypeAny> {
  description: string;
  inputSchema: TSchema;
  execute?: (input: z.infer<TSchema>, options: ToolCallOptions) => Promise<unknown> | unknown;
}

export function tool<TSchema extends ZodTypeAny>(definition: ToolDefinition<TSchema>): ToolDefinition<TSchema> {
  return definition;
}
