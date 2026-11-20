import * as z from "zod";
import { getDb } from "@/chat/db";
import { readReviewItemAgentScope } from "@/chat/review-items/access";
import { resolveAssignee } from "@/chat/review-items/assignees";
import {
  searchReviewItems,
  type ReviewItemStatus,
} from "@/chat/review-items/store";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { zodTool, zodToolDefinition } from "@/chat/tool-support/zod-tool";
import {
  REVIEW_DESK_TOOL_SOURCE,
  itemResult,
  type ReviewItemToolContext,
  type ReviewItemToolServices,
} from "@/chat/review-items/tool-support";

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 25;

export const searchReviewItemsToolDefinition = zodToolDefinition({
  description:
    "Search review desk items that you can see, newest change first. For example, find the open items for one pull request before you add or close one.",
  exposure: "deferred",
  source: REVIEW_DESK_TOOL_SOURCE,
  annotations: {
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
    readOnlyHint: true,
  },
  inputSchema: z
    .object({
      subject_id: z.string().trim().min(1).max(500).nullable().optional(),
      status: z
        .enum(["open", "done", "dismissed", "any"])
        .nullable()
        .optional()
        .describe("Default `open`."),
      assignee: z
        .string()
        .trim()
        .min(1)
        .max(320)
        .nullable()
        .optional()
        .describe("`everyone`, an email, or a mention such as `<@U123>`."),
      automation_id: z.string().trim().min(1).nullable().optional(),
      conversation_id: z.string().trim().min(1).nullable().optional(),
      limit: z
        .number()
        .int()
        .min(1)
        .max(MAX_LIMIT)
        .nullable()
        .optional()
        .describe(`Default ${DEFAULT_LIMIT}; max ${MAX_LIMIT}.`),
    })
    .strict(),
  outputSchema: juniorToolOutputSchema,
});

/** Create the tool that searches Review items. */
export function createSearchReviewItemsTool(
  context: ReviewItemToolContext,
  services: Pick<ReviewItemToolServices, "findMentionedUserId">,
) {
  return zodTool({
    ...searchReviewItemsToolDefinition,
    execute: async (input) => {
      const db = getDb();
      const scope = await readReviewItemAgentScope(context);
      const status = input.status ?? "open";
      const statuses: ReviewItemStatus[] =
        status === "any" ? ["open", "done", "dismissed"] : [status];
      const items = await searchReviewItems(db, scope.reader, {
        limit: input.limit ?? DEFAULT_LIMIT,
        statuses,
        ...(input.assignee
          ? {
              assignee: await resolveAssignee(
                db,
                input.assignee,
                scope.tenant,
                services.findMentionedUserId,
              ),
            }
          : undefined),
        ...(input.automation_id
          ? { automationId: input.automation_id }
          : undefined),
        ...(input.conversation_id
          ? { conversationId: input.conversation_id }
          : undefined),
        ...(input.subject_id ? { subjectId: input.subject_id } : undefined),
      });
      return { count: items.length, items: items.map(itemResult) };
    },
  });
}
