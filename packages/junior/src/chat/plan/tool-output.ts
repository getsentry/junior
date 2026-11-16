import * as z from "zod";
import { PLAN_ITEM_STATUSES, type PlanItem } from "@/chat/plan/types";

/** Plan item shape in tool results. */
export const planItemOutputSchema = z
  .object({
    id: z.number().int(),
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
    id: item.id,
    title: item.title,
    ...(item.notes ? { notes: item.notes } : undefined),
    status: item.status,
    assignee,
  };
}
