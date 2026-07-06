import { z, type ZodTypeAny } from "zod";
import type {
  AnyToolDefinition,
  JsonSchemaObject,
  ToolExecuteOptions,
} from "@/chat/tools/definition";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";

type ZodToolDefinition<
  TInputSchema extends ZodTypeAny,
  TOutputSchema extends ZodTypeAny | undefined = undefined,
> = Pick<
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
