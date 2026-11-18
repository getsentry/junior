import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { automationListQuerySchema } from "@/api/schema/automation";
import { readViewerAutomations } from "@/chat/automations/read";
import { mcpAutomation, mcpAutomationSchema } from "../automation";
import { mcpToolResult, type McpToolContext } from "../tool-context";

/** Register `searchAutomations`, which searches the Automations the user can see. */
export function registerSearchAutomationsTool(
  server: McpServer,
  { user }: McpToolContext,
): void {
  // oxlint-disable-next-line anti-slop/no-shape-in-symbol-names -- `shape` is the Zod object API.
  const listQuery = automationListQuerySchema.shape;
  server.registerTool(
    "searchAutomations",
    {
      title: "Search automations",
      description:
        "Search the automations that you can see, newest first. An automation is a saved instruction or skill that runs on a schedule or on events.",
      inputSchema: {
        q: listQuery.q.describe(
          "Text to search for in titles, instructions, and skill names.",
        ),
        scope: z
          .enum(["all", "mine", "attention"])
          .default("all")
          .describe(
            "`mine` lists the ones you created. `attention` lists the ones that are blocked, cannot run, or had a problem in their last run.",
          ),
        state: listQuery.state.describe("Filter by state."),
        skill: listQuery.skill.describe(
          "Only automations that run this skill, by exact name.",
        ),
        page: listQuery.page.describe("Page number, from 1."),
      },
      outputSchema: {
        automations: z.array(mcpAutomationSchema),
        total: z.number().int().describe("Matches across every page."),
      },
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
        readOnlyHint: true,
      },
    },
    async ({ page, q, scope, skill, state }) => {
      const list = await readViewerAutomations(
        user,
        automationListQuerySchema.parse({ page, q, scope, skill, state }),
      );
      return mcpToolResult({
        automations: list.automations.map(mcpAutomation),
        total: list.total,
      });
    },
  );
}
