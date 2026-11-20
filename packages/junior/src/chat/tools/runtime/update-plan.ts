import * as z from "zod";
import { readConversationAccessFromSql } from "@/api/conversations/access";
import { findChildAgentConversationId } from "@/chat/agent-invocations/bindings";
import { getDb, getSqlExecutor } from "@/chat/db";
import { renderPlanAssignee } from "@/chat/plan/prompt";
import {
  changePlan,
  listPlanItems,
  type StoredPlanAssignee,
} from "@/chat/plan/store";
import {
  outputPlanItem,
  parsePlanItemRef,
  planItemOutputSchema,
  planItemRef,
  planItemRefSchema,
} from "@/chat/plan/tool-output";
import {
  isOpenPlanItemStatus,
  PLAN_ITEM_STATUSES,
  SELF_PLAN_ASSIGNEE,
  type PlanItem,
} from "@/chat/plan/types";
import {
  resolveAssignee,
  type FindMentionedUserId,
} from "@/chat/review-items/assignees";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { zodTool, zodToolDefinition } from "@/chat/tool-support/zod-tool";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";
import type { ToolRuntimeContext } from "@/chat/tools/types";

const MAX_ITEMS_PER_CALL = 50;

const statusSchema = z
  .enum(PLAN_ITEM_STATUSES)
  .describe("done and cancelled close the item.");

const assigneeSchema = z
  .string()
  .trim()
  .min(1)
  .max(320)
  .describe(
    "Who does the item: `self`, the name or conversation_id of a child agent, or a person's email or mention such as `<@U123>`. Null or omitted on a new item means `self`.",
  );

const titleSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .describe("Short outcome to reach.");

const notesSchema = z
  .string()
  .trim()
  .min(1)
  .max(2000)
  .describe(
    "What you need to do the item later, such as the brief for a child agent.",
  );

const itemIdSchema = planItemRefSchema.describe(
  "Plan item id, such as `TODO-12`, from an earlier result or a plan block.",
);

const changesSchema = <T extends z.ZodTypeAny>(item: T) =>
  z.array(item).min(1).max(MAX_ITEMS_PER_CALL).nullable().optional();

const updatePlanInputSchema = z
  .object({
    add: changesSchema(
      z
        .object({
          title: titleSchema,
          notes: notesSchema.nullable().optional(),
          status: statusSchema
            .nullable()
            .optional()
            .describe("Null or omitted means pending."),
          assignee: assigneeSchema.nullable().optional(),
        })
        .strict(),
    ).describe("New items."),
    update: changesSchema(
      z
        .object({
          id: itemIdSchema,
          title: titleSchema.nullable().optional(),
          notes: notesSchema
            .nullable()
            .optional()
            .describe("New notes. Null clears them; omit to keep them."),
          status: statusSchema.nullable().optional(),
          assignee: assigneeSchema.nullable().optional(),
        })
        .strict(),
    ).describe("Changes to existing items. Null or omitted fields stay."),
    remove: changesSchema(itemIdSchema).describe(
      "Ids of items added by mistake. Close finished or dropped work with a status instead.",
    ),
  })
  .strict();

const updatePlanOutputSchema = juniorToolOutputSchema.extend({
  items: z
    .array(planItemOutputSchema)
    .describe(
      "Items that this call added or changed, or every open item when it changed none.",
    ),
  removed_ids: z.array(z.string()).optional(),
  replaced_person_changes: z
    .array(
      z
        .object({
          id: z.string(),
          status: z.enum(PLAN_ITEM_STATUSES),
          changed_by: z.string(),
        })
        .strict(),
    )
    .optional()
    .describe(
      "Statuses that a person set and this call replaced. Check that the person agrees, or set the status back.",
    ),
});

export const updatePlanToolDefinition = zodToolDefinition({
  annotations: {
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
    readOnlyHint: false,
  },
  description:
    "Change the plan: the durable list of work that outlives this Turn, such as work queued for a later Turn, work for a child agent, or work for a person. It survives context compaction and sandbox resets. Do not add steps that you finish in this Turn. Give work for a child agent that child as assignee, with the brief in notes if you send it later. Each assignee can have one item in progress. Returns the items that changed, or every open item when the call changes nothing.",
  inputSchema: updatePlanInputSchema,
  outputSchema: updatePlanOutputSchema,
});

function outputItem(item: PlanItem) {
  return outputPlanItem(item, renderPlanAssignee(item.assignee));
}

/**
 * Resolve the assignee text of the model: the plan's own agent, one of its
 * child agents, or a person. Only a child of this conversation can take an
 * item, as with `stopAgent`.
 */
async function resolvePlanAssignee(
  context: Pick<ToolRuntimeContext, "conversationId">,
  value: string,
  findMentionedUserId: FindMentionedUserId,
): Promise<StoredPlanAssignee> {
  const text = value.trim();
  if (
    text.toLowerCase() === SELF_PLAN_ASSIGNEE ||
    text === context.conversationId
  ) {
    return { conversationId: context.conversationId };
  }
  const childConversationId = await findChildAgentConversationId({
    parentConversationId: context.conversationId,
    target: text,
  });
  if (childConversationId) return { conversationId: childConversationId };
  // An email or a mention. Its errors say how to fix a person who has no
  // Junior User.
  if (text.includes("@")) {
    const db = getDb();
    const tenant = (
      await readConversationAccessFromSql(db, [context.conversationId])
    ).get(context.conversationId)?.tenant;
    const person = await resolveAssignee(db, text, tenant, findMentionedUserId);
    if ("userId" in person) return { userId: person.userId };
  }
  throw new ToolInputError(
    `Unknown assignee ${JSON.stringify(text)}. Use ${SELF_PLAN_ASSIGNEE}, the name or conversation_id of a child agent from listAgents, or the email or mention of one person.`,
  );
}

/** Create the tool that changes the durable plan of one conversation. */
export function createUpdatePlanTool(
  context: Pick<ToolRuntimeContext, "conversationId">,
  findMentionedUserId: FindMentionedUserId,
) {
  const assignee = (value: string) =>
    resolvePlanAssignee(context, value, findMentionedUserId);
  return zodTool({
    ...updatePlanToolDefinition,
    execute: async (input) => {
      const add = input.add ?? [];
      const update = input.update ?? [];
      const remove = (input.remove ?? []).map(parsePlanItemRef);
      const executor = getSqlExecutor();
      if (add.length + update.length + remove.length === 0) {
        const items = await listPlanItems(executor, context.conversationId);
        return {
          items: items
            .filter((item) => isOpenPlanItemStatus(item.status))
            .map(outputItem),
        };
      }
      const { items, replacedPersonChanges } = await changePlan(executor, {
        conversationId: context.conversationId,
        nowMs: Date.now(),
        change: {
          add: await Promise.all(
            // oxlint-disable-next-line junior/bounded-fan-out -- The tool schema allows at most 50 items.
            add.map(async (item) => ({
              title: item.title,
              ...(item.notes ? { notes: item.notes } : undefined),
              status: item.status ?? "pending",
              assignee: await assignee(item.assignee ?? SELF_PLAN_ASSIGNEE),
            })),
          ),
          update: await Promise.all(
            // oxlint-disable-next-line junior/bounded-fan-out -- The tool schema allows at most 50 items.
            update.map(async (item) => ({
              id: parsePlanItemRef(item.id),
              ...(item.title ? { title: item.title } : undefined),
              ...(item.notes !== undefined ? { notes: item.notes } : undefined),
              ...(item.status ? { status: item.status } : undefined),
              ...(item.assignee
                ? { assignee: await assignee(item.assignee) }
                : undefined),
            })),
          ),
          remove,
        },
      });
      return {
        items: items.map(outputItem),
        ...(remove.length > 0
          ? { removed_ids: remove.map(planItemRef) }
          : undefined),
        ...(replacedPersonChanges.length > 0
          ? {
              replaced_person_changes: replacedPersonChanges.map((item) => ({
                id: planItemRef(item.id),
                status: item.status,
                changed_by: item.changedBy!.email,
              })),
            }
          : undefined),
      };
    },
  });
}
