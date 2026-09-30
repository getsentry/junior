import { z } from "zod";
import { botConfig } from "@/chat/config";
import { getDb } from "@/chat/db";
import { isExperimentalFeatureEnabled } from "@/chat/experimental";
import { defaultModelId } from "@/chat/model-profile";
import { completeObject } from "@/chat/pi/client";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { zodTool } from "@/chat/tool-support/zod-tool";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";
import type { ToolRegistry } from "@/chat/tools/definition";
import { OPERATOR_TOOL_SOURCE } from "@/chat/tools/operator-sql";
import type { ToolRuntimeContext } from "@/chat/tools/types";
import {
  readSpaceBackfillCandidates,
  renderSpaceBackfillMarkdown,
  runSpaceBackfill,
} from "./backfill";
import { isSpacesEnabled } from "./registration";

const DEFAULT_BACKFILL_LIMIT = 10;
// One classifier call per Conversation must fit in one Turn.
const MAX_BACKFILL_LIMIT = 50;

/**
 * Build the operator tool that runs the Space backfill inside the deployment.
 *
 * It exists only when Spaces and `operator-tools` are both on, and never in
 * public Conversations, like `runOperatorSql`.
 */
export function createSpaceBackfillTools(
  context: ToolRuntimeContext,
): ToolRegistry {
  if (!isSpacesEnabled()) return {};
  if (!isExperimentalFeatureEnabled("operator-tools")) return {};
  if (context.conversationPrivacy === "public") return {};

  return {
    runSpaceBackfill: zodTool({
      exposure: "deferred",
      source: OPERATOR_TOOL_SOURCE,
      executionMode: "sequential",
      annotations: {
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
        readOnlyHint: false,
      },
      description:
        "Run the Space backfill, the same as `junior spaces backfill`. It classifies unassigned root Conversations that have a Brief, oldest first, with one model call each. Without apply it is a dry run that writes nothing and returns the proposed Space outline and model cost. Start with a small dry run and show the report before you apply or raise the limit.",
      inputSchema: z
        .object({
          apply: z
            .boolean()
            .nullable()
            .optional()
            .describe("Write Spaces and assignments. Default false."),
          limit: z
            .number()
            .int()
            .min(1)
            .max(MAX_BACKFILL_LIMIT)
            .nullable()
            .optional()
            .describe(
              `Maximum Conversations to classify. Default ${DEFAULT_BACKFILL_LIMIT}.`,
            ),
          since: z
            .string()
            .trim()
            .min(1)
            .nullable()
            .optional()
            .describe(
              "Only Conversations created at or after this ISO-8601 date.",
            ),
        })
        .strict(),
      outputSchema: juniorToolOutputSchema.extend({
        applied: z.boolean(),
        candidates: z.number().int(),
        assigned: z.number().int(),
        unassigned: z.number().int(),
        created_spaces: z.number().int(),
        cost_usd: z.number(),
        model_id: z.string(),
        report: z.string(),
      }),
      async execute(input) {
        const apply = input.apply === true;
        const sinceMs = input.since ? Date.parse(input.since) : undefined;
        if (sinceMs !== undefined && !Number.isFinite(sinceMs)) {
          throw new ToolInputError("since must be an ISO-8601 date");
        }
        const db = getDb();
        const candidates = await readSpaceBackfillCandidates(db, {
          limit: input.limit ?? DEFAULT_BACKFILL_LIMIT,
          ...(sinceMs !== undefined ? { sinceMs } : undefined),
        });
        const modelId = defaultModelId(botConfig);
        const result = await runSpaceBackfill(db, {
          candidates,
          apply,
          completeObject: (request) =>
            completeObject({
              ...request,
              modelId,
              promptName: "junior.space_backfill",
            }),
        });
        return {
          applied: apply,
          candidates: candidates.length,
          assigned: result.assigned,
          unassigned: result.unassigned,
          created_spaces: result.createdSpaces,
          cost_usd: result.costUsd,
          model_id: modelId,
          report: renderSpaceBackfillMarkdown(result, { apply }),
        };
      },
    }),
  };
}
