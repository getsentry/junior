import { and, eq, lte } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/chat/db";
import { juniorConversations } from "@/db/schema";
import type { ApiRoute } from "../route";
import { parseParams } from "../http";
import { conversationParamsSchema } from "../schema";

const archiveBodySchema = z
  .object({ archived: z.boolean(), lastSeenAt: z.string().datetime() })
  .strict();

/** Set or clear the dashboard archive marker for one conversation. */
export async function setConversationArchived(args: {
  archived: boolean;
  conversationId: string;
  nowMs?: number;
}): Promise<boolean> {
  const rows = await getDb()
    .update(juniorConversations)
    .set({
      archivedAt: args.archived ? new Date(args.nowMs ?? Date.now()) : null,
    })
    .where(eq(juniorConversations.conversationId, args.conversationId))
    .returning({ conversationId: juniorConversations.conversationId });
  return rows.length > 0;
}

async function archiveIfUnchanged(args: {
  archived: boolean;
  conversationId: string;
  lastSeenAt: string;
}): Promise<"conflict" | "not_found" | "updated"> {
  const db = getDb();
  const rows = await db
    .update(juniorConversations)
    .set({ archivedAt: args.archived ? new Date() : null })
    .where(
      and(
        eq(juniorConversations.conversationId, args.conversationId),
        args.archived
          ? lte(juniorConversations.lastActivityAt, new Date(args.lastSeenAt))
          : undefined,
      ),
    )
    .returning({ conversationId: juniorConversations.conversationId });
  if (rows.length > 0) return "updated";
  const [existing] = await db
    .select({ conversationId: juniorConversations.conversationId })
    .from(juniorConversations)
    .where(eq(juniorConversations.conversationId, args.conversationId))
    .limit(1);
  return existing ? "conflict" : "not_found";
}

/** Serve the archive mutation with optimistic activity concurrency control. */
export const conversationArchiveRoute: ApiRoute = {
  method: "patch",
  path: "/:conversationId/archive",
  handler: async (c) => {
    const { conversationId } = parseParams(
      conversationParamsSchema,
      c.req.param(),
    );
    const body = archiveBodySchema.parse(await c.req.json());
    const result = await archiveIfUnchanged({ ...body, conversationId });
    if (result === "not_found") {
      return Response.json(
        { error: "Conversation not found." },
        { status: 404 },
      );
    }
    if (result === "conflict") {
      return Response.json(
        { error: "Conversation received new activity." },
        { status: 409 },
      );
    }
    return Response.json({ archived: body.archived });
  },
};
