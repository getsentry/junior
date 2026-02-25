import { tool } from "ai";
import { z } from "zod";
import { createTodoList } from "@/chat/slack-actions/lists";
import type { ToolState } from "@/chat/tools/types";

export function createSlackListCreateTool(state: ToolState) {
  return tool({
    description: "Create a Slack todo list for action tracking.",
    inputSchema: z.object({
      name: z
        .string()
        .min(1)
        .max(160)
        .describe("Name for the new Slack list.")
    }),
    execute: async ({ name }) => {
      try {
        const list = await createTodoList(name);
        state.patchArtifactState({
          lastListId: list.listId,
          lastListUrl: list.permalink,
          listColumnMap: list.listColumnMap
        });

        return {
          ok: true,
          list_id: list.listId,
          permalink: list.permalink,
          column_map: list.listColumnMap
        };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : "list create failed"
        };
      }
    }
  });
}
