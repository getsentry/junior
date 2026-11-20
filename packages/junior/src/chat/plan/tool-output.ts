import * as z from "zod";
import { PLAN_ITEM_STATUSES, type PlanItem } from "@/chat/plan/types";

// The model sees `TODO-12`, not `12` or `#12`: a bare `#12` in a reply reads
// as a GitHub pull request or issue.
const PLAN_ITEM_REF_PREFIX = "TODO-";

/** Render the model-facing reference of a Plan item id. */
export function planItemRef(id: number): string {
  return `${PLAN_ITEM_REF_PREFIX}${id}`;
}

/** Plan item reference that the model passes back to a tool, such as `TODO-12`. */
export const planItemRefSchema = z
  .string()
  .trim()
  .regex(
    new RegExp(`^${PLAN_ITEM_REF_PREFIX}[1-9]\\d*$`),
    `Use a Plan item reference such as ${PLAN_ITEM_REF_PREFIX}12.`,
  );

/** Read the Plan item id from a reference that `planItemRefSchema` accepted. */
export function parsePlanItemRef(ref: string): number {
  return Number(ref.trim().slice(PLAN_ITEM_REF_PREFIX.length));
}

/** Plan item shape in tool results. */
export const planItemOutputSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    notes: z.string().optional(),
    status: z.enum(PLAN_ITEM_STATUSES),
    assignee: z.string(),
  })
  .strict();

/** Render one Plan item for a tool result, with assignee text for the reader. */
export function outputPlanItem(
  item: PlanItem,
  assignee: string,
): z.output<typeof planItemOutputSchema> {
  return {
    id: planItemRef(item.id),
    title: item.title,
    ...(item.notes ? { notes: item.notes } : undefined),
    status: item.status,
    assignee,
  };
}
