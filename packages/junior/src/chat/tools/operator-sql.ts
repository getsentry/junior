import { z } from "zod";
import { getSqlExecutor } from "@/chat/db";
import { isExperimentalFeatureEnabled } from "@/chat/experimental";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { zodTool } from "@/chat/tool-support/zod-tool";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";
import type { ToolRegistry } from "@/chat/tools/definition";
import type { ToolRuntimeContext } from "@/chat/tools/types";

/** Deferred tool catalog source for operator tools. */
export const OPERATOR_TOOL_SOURCE = {
  id: "operator",
  description:
    "Run SQL directly against this deployment's database. Enabled only on deployments that opt in, such as Previews.",
} as const;

const DEFAULT_ROW_LIMIT = 50;
const MAX_ROW_LIMIT = 200;
const MAX_OUTPUT_CHARS = 40_000;

const paramSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

/** Find the Postgres SQLSTATE code that marks a statement the caller can fix. */
function findSqlState(
  error: unknown,
): { code: string; message: string } | undefined {
  for (let current = error; current instanceof Error; current = current.cause) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) {
      return { code, message: current.message };
    }
  }
  return undefined;
}

/** Keep the tool result small enough for the model context. */
function limitRows(rows: unknown[], rowLimit: number) {
  const limited = rows.slice(0, rowLimit);
  while (
    limited.length > 0 &&
    JSON.stringify(limited).length > MAX_OUTPUT_CHARS
  ) {
    limited.pop();
  }
  return limited;
}

/**
 * Build the operator tools when the app enables `operator-tools`.
 *
 * These tools bypass every Conversation privacy gate, so they only exist in
 * non-public Conversations. Their results never reach a public transcript or a
 * public Brief.
 */
export function createOperatorTools(context: ToolRuntimeContext): ToolRegistry {
  if (!isExperimentalFeatureEnabled("operator-tools")) return {};
  if (context.conversationPrivacy === "public") return {};

  return {
    runOperatorSql: zodTool({
      exposure: "deferred",
      source: OPERATOR_TOOL_SOURCE,
      executionMode: "sequential",
      annotations: {
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
        readOnlyHint: false,
      },
      description:
        "Run one SQL statement against this deployment's Postgres database and return its rows. Reads and writes are allowed. Add RETURNING to see rows changed by INSERT, UPDATE, or DELETE. Use $1, $2 placeholders with params for values.",
      inputSchema: z
        .object({
          statement: z.string().trim().min(1).max(20_000),
          params: z
            .array(paramSchema)
            .max(100)
            .nullable()
            .optional()
            .describe("Values for $1, $2, ... placeholders."),
          row_limit: z
            .number()
            .int()
            .min(1)
            .max(MAX_ROW_LIMIT)
            .nullable()
            .optional()
            .describe(`Maximum rows to return. Default ${DEFAULT_ROW_LIMIT}.`),
        })
        .strict(),
      outputSchema: juniorToolOutputSchema.extend({
        row_count: z.number().int(),
        rows: z.array(z.unknown()),
        truncated: z.boolean(),
      }),
      async execute(input) {
        let rows: unknown[];
        try {
          const result = await getSqlExecutor().query(
            input.statement,
            input.params ?? [],
          );
          // A statement list without params returns no single row array.
          rows = Array.isArray(result) ? result : [];
        } catch (error) {
          const sqlState = findSqlState(error);
          if (!sqlState) throw error;
          throw new ToolInputError(
            `SQL error ${sqlState.code}: ${sqlState.message}`,
            { cause: error },
          );
        }
        const returned = limitRows(rows, input.row_limit ?? DEFAULT_ROW_LIMIT);
        return {
          row_count: rows.length,
          rows: returned,
          truncated: returned.length < rows.length,
        };
      },
    }),
  };
}
