import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { Kind, type Static, type TSchema } from "@sinclair/typebox";
import type { ToolExecutionMode } from "@earendil-works/pi-agent-core";
import { z, type ZodTypeAny } from "zod";
import type { ConversationPrivacy } from "@/chat/conversation-privacy";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";

/**
 * Tool definition boundary for Pi-facing agent tools. `tool()` keeps the
 * legacy TypeBox path, while `zodTool()` projects Zod schemas to JSON Schema
 * and owns model-input parse errors before execution.
 */
export interface JsonSchemaObject {
  [key: string]: unknown;
}
export type ToolInputSchema = TSchema | JsonSchemaObject;

export type ToolExposure = "direct" | "deferred" | "modelOnly" | "hidden";

export interface ToolExecuteOptions {
  experimental_context?: unknown;
  signal?: AbortSignal;
  conversationPrivacy?: ConversationPrivacy;
  toolCallId?: string;
}

interface BaseToolDefinition<TInput, TInputSchema extends ToolInputSchema> {
  /** Stable internal owner-qualified identity for plugin-contributed tools. */
  identity?: {
    id: string;
    name: string;
    plugin: string;
  };
  description: string;
  exposure?: ToolExposure;
  inputSchema: TInputSchema;
  annotations?: ToolAnnotations;
  /**
   * @deprecated Put tool-selection and usage guidance directly in `description`
   * and parameter descriptions. Retained for plugin compatibility; may be
   * removed in a future major version.
   */
  promptSnippet?: string;
  /**
   * @deprecated Put tool-selection and usage guidance directly in `description`
   * and parameter descriptions. Retained for plugin compatibility; may be
   * removed in a future major version.
   */
  promptGuidelines?: string[];
  prepareArguments?: (args: unknown) => TInput;
  executionMode?: ToolExecutionMode;
  execute?: (
    input: TInput,
    options: ToolExecuteOptions,
  ) => Promise<unknown> | unknown;
}

export interface ToolDefinition<
  TInputSchema extends TSchema = TSchema,
> extends BaseToolDefinition<Static<TInputSchema>, TInputSchema> {}

/**
 * Schema-erased view for heterogeneous registries after Pi validates tool input.
 */
export interface AnyToolDefinition {
  /** Stable internal owner-qualified identity for plugin-contributed tools. */
  identity?: {
    id: string;
    name: string;
    plugin: string;
  };
  description: string;
  exposure?: ToolExposure;
  inputSchema: ToolInputSchema;
  annotations?: ToolAnnotations;
  /**
   * @deprecated Put tool-selection and usage guidance directly in `description`
   * and parameter descriptions. Retained for plugin compatibility; may be
   * removed in a future major version.
   */
  promptSnippet?: string;
  /**
   * @deprecated Put tool-selection and usage guidance directly in `description`
   * and parameter descriptions. Retained for plugin compatibility; may be
   * removed in a future major version.
   */
  promptGuidelines?: string[];
  executionMode?: ToolExecutionMode;
  execute?(
    input: unknown,
    options: ToolExecuteOptions,
  ): Promise<unknown> | unknown;
  prepareArguments?(args: unknown): unknown;
}

/** Distinguish legacy TypeBox schemas from JSON Schema projected from Zod. */
export function isTypeBoxInputSchema(schema: ToolInputSchema): schema is TSchema {
  return typeof schema === "object" && schema !== null && Kind in schema;
}

/** Infer execute parameter types from the inputSchema via generic binding. */
export function tool<TInputSchema extends TSchema>(
  definition: ToolDefinition<TInputSchema>,
): ToolDefinition<TInputSchema> {
  return definition;
}

type ZodToolDefinition<
  TInputSchema extends ZodTypeAny,
  TOutputSchema extends ZodTypeAny | undefined = undefined,
> = Omit<
  BaseToolDefinition<z.output<TInputSchema>, JsonSchemaObject>,
  "inputSchema" | "prepareArguments" | "execute"
> & {
  inputSchema: TInputSchema;
  outputSchema?: TOutputSchema;
  prepareArguments?: (args: unknown) => z.input<TInputSchema>;
  execute?: (
    input: z.output<TInputSchema>,
    options: ToolExecuteOptions,
  ) =>
    | Promise<
        TOutputSchema extends ZodTypeAny ? z.input<TOutputSchema> : unknown
      >
    | (TOutputSchema extends ZodTypeAny ? z.input<TOutputSchema> : unknown);
};

function formatZodPath(path: readonly PropertyKey[]): string {
  return path.length > 0 ? path.map(String).join(".") : "root";
}

function formatToolInputError(error: z.ZodError): string {
  const details = error.issues
    .slice(0, 5)
    .map((issue) => `${formatZodPath(issue.path)}: ${issue.message}`)
    .join("; ");
  return `Invalid tool arguments: ${details || "input did not match schema"}`;
}

function parseToolInput<TInputSchema extends ZodTypeAny>(
  schema: TInputSchema,
  args: unknown,
): z.output<TInputSchema> {
  const result = schema.safeParse(args);
  if (!result.success) {
    throw new ToolInputError(formatToolInputError(result.error), {
      cause: result.error,
    });
  }
  return result.data;
}

/**
 * Define a Junior-owned tool with Zod input parsing and JSON Schema parameters.
 */
export function zodTool<
  TInputSchema extends ZodTypeAny,
  TOutputSchema extends ZodTypeAny | undefined = undefined,
>(
  definition: ZodToolDefinition<TInputSchema, TOutputSchema>,
): AnyToolDefinition {
  const { inputSchema, outputSchema, prepareArguments, execute, ...toolDef } =
    definition;
  let modelInputSchema: JsonSchemaObject;
  try {
    modelInputSchema = z.toJSONSchema(inputSchema) as JsonSchemaObject;
  } catch (error) {
    throw new TypeError(
      "zodTool() inputSchema must be representable as JSON Schema.",
      { cause: error },
    );
  }
  return {
    ...toolDef,
    inputSchema: modelInputSchema,
    prepareArguments(args) {
      return parseToolInput(
        inputSchema,
        prepareArguments ? prepareArguments(args) : args,
      );
    },
    ...(execute
      ? {
          async execute(input, options) {
            const result = await execute(
              input as z.output<TInputSchema>,
              options,
            );
            return outputSchema ? outputSchema.parse(result) : result;
          },
        }
      : {}),
  };
}
