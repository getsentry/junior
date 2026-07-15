import { readConversationFeedFromSql } from "./list.query";
import { conversationFeedSchema } from "./schema";
import type { ConversationFeed } from "./schema";
import type { ApiRoute } from "../route";
import { parseQuery } from "../http";
import { conversationFeedQuerySchema } from "../schema";

/**
 * Load a bounded feed with an optional normalized actor-email presentation
 * filter. This filter is not an authorization boundary.
 */
export async function readConversationFeed(
  options: { actorEmail?: string } = {},
): Promise<ConversationFeed> {
  return conversationFeedSchema.parse(
    await readConversationFeedFromSql({ actorEmail: options.actorEmail }),
  );
}

/** Serve the conversation feed endpoint. */
export default {
  method: "get",
  path: "/",
  handler: async (c) => {
    const { actorEmail } = parseQuery(
      conversationFeedQuerySchema,
      c.req.query(),
    );
    return Response.json(await readConversationFeed({ actorEmail }));
  },
} satisfies ApiRoute;
