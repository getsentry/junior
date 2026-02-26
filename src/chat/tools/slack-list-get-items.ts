import { tool } from "@/chat/tools/definition";
import { Type } from "@sinclair/typebox";
import { listItems } from "@/chat/slack-actions/lists";
import type { ToolState } from "@/chat/tools/types";

export function createSlackListGetItemsTool(state: ToolState) {
  return tool({
    description: "List items from a Slack list.",
    inputSchema: Type.Object({
      list_id: Type.Optional(
        Type.String({
          minLength: 1,
          description: "Optional list ID. Defaults to the last list used in this thread."
        })
      ),
      limit: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: 200,
          description: "Maximum number of list items to return."
        })
      )
    }),
    execute: async ({ list_id, limit }) => {
      const targetListId = list_id ?? state.getCurrentListId();
      const resolvedLimit = limit ?? 100;
      if (!targetListId) {
        return { ok: false, error: "No list_id provided and no prior list found in thread state" };
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
