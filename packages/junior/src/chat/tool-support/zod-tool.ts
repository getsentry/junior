import { z, type ZodType, type ZodTypeAny } from "zod";
import {
  juniorToolResultSchema,
  type JuniorToolResult,
} from "@/chat/tool-support/structured-result";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type {
  AnyToolDefinition,
  JsonSchemaObject,
  ToolExecuteOptions,
} from "@/chat/tools/definition";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";

type ZodToolDefinitionBase<TInputSchema extends ZodTypeAny> = Pick<
  AnyToolDefinition,
  | "identity"
  | "description"
  | "exposure"
  | "annotations"
  | "promptSnippet"
  | "promptGuidelines"
  | "executionMode"
> & {
  inputSchema: TInputSchema;
  prepareArguments?: (args: unknown) => z.input<TInputSchema>;
};

type StructuredToolExecuteResult<
  TOutputSchema extends ZodType<JuniorToolResult>,
> = z.input<TOutputSchema>;

interface ContentOnlyToolResult {
  content: Array<TextContent | ImageContent>;
  details?: never;
}

type StructuredZodToolDefinition<
  TInputSchema extends ZodTypeAny,
  TOutputSchema extends ZodType<JuniorToolResult>,
> = ZodToolDefinitionBase<TInputSchema> & {
  outputSchema: TOutputSchema;
  execute?: (
    input: z.output<TInputSchema>,
    options: ToolExecuteOptions,
  ) =>
    | Promise<StructuredToolExecuteResult<TOutputSchema>>
    | StructuredToolExecuteResult<TOutputSchema>;
};

type ContentZodToolDefinition<TInputSchema extends ZodTypeAny> =
  ZodToolDefinitionBase<TInputSchema> & {
    outputSchema?: undefined;
    execute?: (
      input: z.output<TInputSchema>,
      options: ToolExecuteOptions,
    ) => Promise<ContentOnlyToolResult> | ContentOnlyToolResult;
  };

type ZodToolDefinition<
  TInputSchema extends ZodTypeAny,
  TOutputSchema extends ZodType<JuniorToolResult>,
> =
  | StructuredZodToolDefinition<TInputSchema, TOutputSchema>
  | ContentZodToolDefinition<TInputSchema>;

function isContentOnlyToolResult(
  value: unknown,
): value is ContentOnlyToolResult {
  return (
    value !== null &&
    typeof value === "object" &&
    Array.isArray((value as { content?: unknown }).content) &&
    !("details" in value)
  );
}

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
  TOutputSchema extends ZodType<JuniorToolResult>,
>(
  definition: StructuredZodToolDefinition<TInputSchema, TOutputSchema>,
): AnyToolDefinition;
export function zodTool<TInputSchema extends ZodTypeAny>(
  definition: ContentZodToolDefinition<TInputSchema>,
): AnyToolDefinition;
export function zodTool<
  TInputSchema extends ZodTypeAny,
  TOutputSchema extends ZodType<JuniorToolResult>,
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
  let modelOutputSchema: JsonSchemaObject | undefined;
  if (outputSchema) {
    try {
      modelOutputSchema = z.toJSONSchema(outputSchema) as JsonSchemaObject;
    } catch (error) {
      throw new TypeError(
        "zodTool() outputSchema must be representable as JSON Schema.",
        { cause: error },
      );
    }
  }
  return {
    ...toolDef,
    inputSchema: modelInputSchema,
    ...(modelOutputSchema ? { outputSchema: modelOutputSchema } : {}),
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
            if (!outputSchema) {
              if (isContentOnlyToolResult(result)) {
                return result;
              }
              throw new TypeError(
                "zodTool() content-only tools must return { content } without details.",
              );
            }
            return outputSchema.parse(juniorToolResultSchema.parse(result));
          },
        }
      : {}),
  };
}
