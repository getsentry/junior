import { tool } from "@/chat/tools/definition";
import { Type } from "@sinclair/typebox";
import { listItems } from "@/chat/slack-actions/lists";
import type { ToolState } from "@/chat/tools/types";

export function createSlackListGetItemsTool(state: ToolState) {
  return tool({
    description:
      "Read items from the active Slack list tracked in artifact context. Use when the user asks for task status, open items, or list contents. Do not use when list state is already known from the immediately prior result.",
    inputSchema: Type.Object({
      limit: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: 200,
          description: "Maximum number of list items to return."
        })
      )
    }),
    execute: async ({ limit }) => {
      const targetListId = state.getCurrentListId();
      const resolvedLimit = limit ?? 100;
      if (!targetListId) {
        return { ok: false, error: "No active list found in artifact context" };
      }

      const items = await listItems(targetListId, resolvedLimit);

      return {
        ok: true,
        list_id: targetListId,
        items: items.map((item) => ({ id: item.id, fields: item.fields }))
      };
    }
  });
}
