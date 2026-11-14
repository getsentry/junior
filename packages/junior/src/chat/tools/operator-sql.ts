import * as z from "zod";
import { getSqlExecutor } from "@/chat/db";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { zodTool, zodToolDefinition } from "@/chat/tool-support/zod-tool";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";

/** Deferred tool catalog source for operator tools. */
export const OPERATOR_TOOL_SOURCE = {
  id: "operator",
  description:
    "Run SQL directly against this deployment's database. Enabled only on deployments that opt in, such as Previews.",
} as const;

const DEFAULT_ROW_LIMIT = 50;
const MAX_ROW_LIMIT = 200;

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

export const runOperatorSqlToolDefinition = zodToolDefinition({
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
});

/**
 * Build the operator SQL tool. The registry offers it when the app enables
 * `operator-tools`.
 *
 * It bypasses every Conversation privacy gate, so `createTools` leaves it out
 * of public Conversations. Its results never reach a public transcript or a
 * public Brief.
 */
export function createRunOperatorSqlTool() {
  return zodTool({
    ...runOperatorSqlToolDefinition,
    async execute(input) {
      let rows: unknown[];
      try {
        rows = await getSqlExecutor().queryIsolated(
          input.statement,
          input.params ?? [],
        );
      } catch (error) {
        const sqlState = findSqlState(error);
        if (!sqlState) throw error;
        throw new ToolInputError(
          `SQL error ${sqlState.code}: ${sqlState.message}`,
          { cause: error },
        );
      }
      const returned = rows.slice(0, input.row_limit ?? DEFAULT_ROW_LIMIT);
      return {
        row_count: rows.length,
        rows: returned,
        truncated: returned.length < rows.length,
      };
    },
  });
}
