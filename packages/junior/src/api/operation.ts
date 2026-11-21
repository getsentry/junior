/**
 * Own API operations: one definition serves a REST route and an MCP tool.
 *
 * Define an operation only when both surfaces take the same input and return
 * the same result. A tool with its own view of the data stays a hand-written
 * MCP tool.
 */
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { Context } from "hono";
import type * as z from "zod";
import type { User } from "@sentry/junior-plugin-api";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";
import { jsonResponse, throwApiError } from "./http";
import type { McpScope } from "./mcp/oauth/scopes";
import type { AuthenticatedApiEnv } from "./route";

/** Services that both surfaces give an operation. */
export interface ApiOperationServices {
  queue: ConversationWorkQueue;
}

/**
 * One operation that a viewer can run. `input` holds the route params and
 * the request body as one object. Its field descriptions are the MCP tool
 * docs. `run` reports a client error with `throwApiError`.
 */
export interface ApiOperation<
  TInput extends z.ZodObject = z.ZodObject,
  TOutput extends z.ZodObject = z.ZodObject,
> {
  name: string;
  title: string;
  description: string;
  /** The MCP scope that unlocks the tool. */
  scope: McpScope;
  input: TInput;
  output: TOutput;
  annotations: Required<
    Pick<ToolAnnotations, "destructiveHint" | "idempotentHint" | "readOnlyHint">
  >;
  run: (
    viewer: User,
    input: z.output<TInput>,
    services: ApiOperationServices,
  ) => Promise<z.input<TOutput>>;
}

/** Define an operation and keep its input and output types. */
export function defineApiOperation<
  TInput extends z.ZodObject,
  TOutput extends z.ZodObject,
>(operation: ApiOperation<TInput, TOutput>): ApiOperation<TInput, TOutput> {
  return operation;
}

async function readJsonBody(
  context: Context<AuthenticatedApiEnv>,
): Promise<unknown> {
  const text = await context.req.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch (error) {
    throwApiError(400, "Invalid request body.", error);
  }
}

/**
 * Serve an operation as a REST handler after `requireViewer`. Route params
 * win over body fields of the same name.
 */
export function apiOperationHandler<
  TInput extends z.ZodObject,
  TOutput extends z.ZodObject,
>(operation: ApiOperation<TInput, TOutput>, services: ApiOperationServices) {
  return async (context: Context<AuthenticatedApiEnv>): Promise<Response> => {
    const body = await readJsonBody(context);
    // A body that is not an object fails the input schema as it is.
    const input = operation.input.safeParse(
      typeof body === "object" && body !== null && !Array.isArray(body)
        ? { ...body, ...context.req.param() }
        : body,
    );
    if (!input.success) {
      throwApiError(400, "Invalid request body.", input.error);
    }
    return jsonResponse(
      operation.output,
      await operation.run(context.get("viewer"), input.data, services),
    );
  };
}
