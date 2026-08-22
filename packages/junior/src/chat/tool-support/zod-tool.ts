import { z, type ZodTypeAny } from "zod";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type {
  AnyToolDefinition,
  JsonSchemaObject,
  ToolExecuteOptions,
} from "@/chat/tools/definition";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";

type ZodToolDefinitionBase<TInputSchema extends ZodTypeAny> = Pick<
  AnyToolDefinition,
  | "approvalMode"
  | "identity"
  | "source"
  | "description"
  | "exposure"
  | "annotations"
  | "promptSnippet"
  | "promptGuidelines"
  | "executionMode"
> & {
  describeProposal?(input: z.output<TInputSchema>): string;
  inputSchema: TInputSchema;
  prepareArguments?: (args: unknown) => z.input<TInputSchema>;
  resolveApprovalMetadata?(
    input: z.output<TInputSchema>,
  ): ReturnType<NonNullable<AnyToolDefinition["resolveApprovalMetadata"]>>;
};

type StructuredToolExecuteResult<TOutputSchema extends ZodTypeAny> =
  | z.input<TOutputSchema>
  | StructuredToolResultEnvelope<z.input<TOutputSchema>>;

interface StructuredToolResultEnvelope<TDetails> {
  content: Array<TextContent | ImageContent>;
  details: TDetails;
}

export interface ContentOnlyToolResult {
  content: Array<TextContent | ImageContent>;
  details?: never;
}

type StructuredZodToolDefinition<
  TInputSchema extends ZodTypeAny,
  TOutputSchema extends ZodTypeAny,
  TExecuteResult extends StructuredToolExecuteResult<TOutputSchema>,
> = ZodToolDefinitionBase<TInputSchema> & {
  outputSchema: TOutputSchema;
  privateTraceResult?(result: z.output<TOutputSchema>): unknown;
  execute?: (
    input: z.output<TInputSchema>,
    options: ToolExecuteOptions,
  ) => Promise<TExecuteResult> | TExecuteResult;
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
  TOutputSchema extends ZodTypeAny,
  TExecuteResult extends StructuredToolExecuteResult<TOutputSchema>,
> =
  | StructuredZodToolDefinition<TInputSchema, TOutputSchema, TExecuteResult>
  | ContentZodToolDefinition<TInputSchema>;

type ParsedStructuredToolExecuteResult<
  TOutputSchema extends ZodTypeAny,
  TExecuteResult,
> =
  TExecuteResult extends StructuredToolResultEnvelope<unknown>
    ? StructuredToolResultEnvelope<z.output<TOutputSchema>>
    : z.output<TOutputSchema>;

type StructuredZodTool<
  TInputSchema extends ZodTypeAny,
  TOutputSchema extends ZodTypeAny,
  TExecuteResult,
> = Omit<
  AnyToolDefinition,
  "inputSchema" | "outputSchema" | "prepareArguments" | "execute"
> & {
  inputSchema: JsonSchemaObject;
  outputSchema: JsonSchemaObject;
  prepareArguments(args: unknown): z.output<TInputSchema>;
  execute?: (
    input: unknown,
    options: ToolExecuteOptions,
  ) =>
    | Promise<ParsedStructuredToolExecuteResult<TOutputSchema, TExecuteResult>>
    | ParsedStructuredToolExecuteResult<TOutputSchema, TExecuteResult>;
};

type ContentZodTool<TInputSchema extends ZodTypeAny> = Omit<
  AnyToolDefinition,
  "inputSchema" | "outputSchema" | "prepareArguments" | "execute"
> & {
  inputSchema: JsonSchemaObject;
  outputSchema?: undefined;
  prepareArguments(args: unknown): z.output<TInputSchema>;
  execute?: (
    input: unknown,
    options: ToolExecuteOptions,
  ) => Promise<ContentOnlyToolResult> | ContentOnlyToolResult;
};

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

function isStructuredToolResultEnvelope(
  value: unknown,
): value is StructuredToolResultEnvelope<unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    Array.isArray((value as { content?: unknown }).content) &&
    "details" in value
  );
}

function parseToolContent(
  content: Array<TextContent | ImageContent>,
): Array<TextContent | ImageContent> {
  for (const item of content) {
    if (
      !item ||
      typeof item !== "object" ||
      (item.type === "text"
        ? typeof item.text !== "string"
        : item.type === "image"
          ? typeof item.data !== "string" || typeof item.mimeType !== "string"
          : true)
    ) {
      throw new TypeError(
        "zodTool() content must contain valid text or image items.",
      );
    }
  }
  return content;
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
  TOutputSchema extends ZodTypeAny,
  TExecuteResult extends StructuredToolExecuteResult<TOutputSchema>,
>(
  definition: StructuredZodToolDefinition<
    TInputSchema,
    TOutputSchema,
    TExecuteResult
  >,
): StructuredZodTool<TInputSchema, TOutputSchema, TExecuteResult>;
export function zodTool<TInputSchema extends ZodTypeAny>(
  definition: ContentZodToolDefinition<TInputSchema>,
): ContentZodTool<TInputSchema>;
export function zodTool<
  TInputSchema extends ZodTypeAny,
  TOutputSchema extends ZodTypeAny,
  TExecuteResult extends StructuredToolExecuteResult<TOutputSchema>,
>(
  definition: ZodToolDefinition<TInputSchema, TOutputSchema, TExecuteResult>,
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
    ...(modelOutputSchema ? { outputSchema: modelOutputSchema } : undefined),
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
            if (isStructuredToolResultEnvelope(result)) {
              return {
                content: parseToolContent(result.content),
                details: outputSchema.parse(result.details),
              };
            }
            return outputSchema.parse(result);
          },
        }
      : undefined),
  };
}
