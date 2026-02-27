import { Type } from "@sinclair/typebox";
import { listChannelMembers } from "@/chat/slack-actions/channel";
import { tool } from "@/chat/tools/definition";
import type { ToolRuntimeContext } from "@/chat/tools/types";

export function createSlackChannelListMembersTool(context: ToolRuntimeContext) {
  return tool({
    description:
      "List member IDs in a Slack channel. Use when the user asks who is in a channel, who to assign, or who should be notified. Do not use when thread-local participant context is sufficient.",
    inputSchema: Type.Object({
      channel_id: Type.Optional(
        Type.String({
          minLength: 1,
          description: "Optional channel ID. Defaults to the current thread channel."
        })
      ),
      limit: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: 200,
          description: "Maximum number of members to return."
        })
      ),
      cursor: Type.Optional(
        Type.String({
          minLength: 1,
          description: "Pagination cursor from a prior call."
        })
      )
    }),
    execute: async ({ channel_id, limit, cursor }) => {
      const targetChannelId = channel_id ?? context.channelId;
      if (!targetChannelId) {
        return { ok: false, error: "No channel_id provided and no active channel context is available" };
      }

      const result = await listChannelMembers({
        channelId: targetChannelId,
        limit: limit ?? 50,
        cursor
      });

      return {
        ok: true,
        channel_id: targetChannelId,
        count: result.members.length,
        next_cursor: result.nextCursor,
        members: result.members
      };
    }
  });
}
