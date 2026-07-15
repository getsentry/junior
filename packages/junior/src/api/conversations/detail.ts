import { readConversationDetailFromSql } from "./detail.query";
import { conversationDetailReportSchema } from "./schema";
import type { ConversationDetailReport } from "./schema";
import type { ApiRoute } from "../route";
import { parseParams } from "../http";
import { conversationParamsSchema } from "../schema";

/** Load one conversation with durable content and recent run diagnostics. */
export async function readConversationDetail(
  conversationId: string,
): Promise<ConversationDetailReport | undefined> {
  const report = await readConversationDetailFromSql(conversationId);
  return report ? conversationDetailReportSchema.parse(report) : undefined;
}

/** Serve one conversation detail endpoint. */
export default {
  method: "get",
  path: "/:conversationId",
  handler: async (c) => {
    const { conversationId } = parseParams(
      conversationParamsSchema,
      c.req.param(),
    );
    const report = await readConversationDetail(conversationId);
    return report
      ? Response.json(report)
      : Response.json({ error: "Conversation not found." }, { status: 404 });
  },
} satisfies ApiRoute;
