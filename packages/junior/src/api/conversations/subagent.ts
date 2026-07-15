import { buildConversationSubagent } from "./detail-projection";
import { readConversationRecordFromSql } from "./list";
import { conversationSubagentTranscriptReportSchema } from "./schema";
import type { ConversationSubagentTranscriptReport } from "./schema";
import type { ApiRoute } from "../route";
import { parseParams } from "../http";
import { subagentParamsSchema } from "../schema";

/** Load one child-agent transcript from durable SQL conversation history. */
export async function readConversationSubagent(
  conversationId: string,
  subagentId: string,
): Promise<ConversationSubagentTranscriptReport> {
  const record = await readConversationRecordFromSql(conversationId);
  if (!record) {
    return conversationSubagentTranscriptReportSchema.parse({
      type: "subagent",
      createdAt: new Date(0).toISOString(),
      id: subagentId,
      status: "error",
      subagentKind: "unknown",
      transcript: [],
      transcriptAvailable: false,
      unavailableReason: "not_found",
    });
  }
  return conversationSubagentTranscriptReportSchema.parse(
    await buildConversationSubagent(record.conversation, subagentId),
  );
}

/** Serve one child-agent transcript endpoint. */
export default {
  method: "get",
  path: "/:conversationId/subagents/:subagentId",
  handler: async (c) => {
    const { conversationId, subagentId } = parseParams(
      subagentParamsSchema,
      c.req.param(),
    );
    const report = await readConversationSubagent(conversationId, subagentId);
    return report.unavailableReason === "not_found"
      ? Response.json(report, { status: 404 })
      : Response.json(report);
  },
} satisfies ApiRoute;
