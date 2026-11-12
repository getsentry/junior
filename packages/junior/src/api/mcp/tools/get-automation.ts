import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { automationExecutionStatusSchema } from "@/api/schema/automation";
import {
  readViewerAutomationExecutions,
  ViewerTaskNotFoundError,
} from "@/chat/automations/read";
import { mcpAutomation, mcpAutomationSchema } from "../automation";
import {
  mcpToolError,
  mcpToolResult,
  type McpToolContext,
} from "../tool-context";

const RECENT_RUN_LIMIT = 10;

/** Register `getAutomation`, which reads one Automation and its recent runs. */
export function registerGetAutomationTool(
  server: McpServer,
  { user }: McpToolContext,
): void {
  server.registerTool(
    "getAutomation",
    {
      title: "Get automation",
      description: `Get one automation and its ${RECENT_RUN_LIMIT} newest runs.`,
      inputSchema: {
        id: z.string().min(1).describe("Automation id from searchAutomations."),
      },
      outputSchema: {
        automation: mcpAutomationSchema,
        runs: z.array(
          z
            .object({
              executedAt: z.string(),
              status: automationExecutionStatusSchema,
              error: z.string().optional(),
              conversationId: z.string().optional(),
            })
            .strict(),
        ),
      },
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
        readOnlyHint: true,
      },
    },
    async ({ id }) => {
      try {
        const list = await readViewerAutomationExecutions(user, id);
        return mcpToolResult({
          automation: mcpAutomation(list.automation),
          runs: list.executions
            .slice(0, RECENT_RUN_LIMIT)
            .map(({ conversationId, error, executedAt, status }) => ({
              executedAt,
              status,
              ...(error ? { error } : undefined),
              ...(conversationId ? { conversationId } : undefined),
            })),
        });
      } catch (error) {
        if (error instanceof ViewerTaskNotFoundError) {
          return mcpToolError("Automation not found.");
        }
        throw error;
      }
    },
  );
}
