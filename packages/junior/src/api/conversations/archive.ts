import { and, eq, isNotNull } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { getDb } from "@/chat/db";
import { juniorConversations } from "@/db/schema";
import type { ApiRoute } from "../route";
import { parseParams } from "../http";
import { conversationParamsSchema } from "../schema";

const archiveBodySchema = z
  .object({ archived: z.boolean(), lastSeenAt: z.string().datetime() })
  .strict();

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
          ? eq(juniorConversations.lastActivityAt, new Date(args.lastSeenAt))
          : isNotNull(juniorConversations.archivedAt),
      ),
    )
    .returning({ conversationId: juniorConversations.conversationId });
  if (rows.length > 0) return "updated";
  const [existing] = await db
    .select({
      archivedAt: juniorConversations.archivedAt,
      conversationId: juniorConversations.conversationId,
    })
    .from(juniorConversations)
    .where(eq(juniorConversations.conversationId, args.conversationId))
    .limit(1);
  if (!existing) return "not_found";
  if (!args.archived && existing.archivedAt === null) return "updated";
  return "conflict";
}

/** Serve the archive mutation with optimistic activity concurrency control. */
export default {
  method: "patch",
  path: "/:conversationId/archive",
  handler: async (c) => {
    const { conversationId } = parseParams(
      conversationParamsSchema,
      c.req.param(),
    );
    let input: unknown;
    try {
      input = await c.req.json();
    } catch (error) {
      throw new HTTPException(400, {
        cause: error,
        message: "Invalid request body.",
      });
    }
    const parsed = archiveBodySchema.safeParse(input);
    if (!parsed.success) {
      throw new HTTPException(400, {
        cause: parsed.error,
        message: "Invalid request body.",
      });
    }
    const body = parsed.data;
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
} satisfies ApiRoute;
