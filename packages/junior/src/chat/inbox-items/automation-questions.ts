import { and, asc, eq } from "drizzle-orm";
import type { JuniorDatabase } from "@/db/db";
import { juniorInboxItems, juniorQuestions } from "@/db/schema";
import { inboxItemAddedByAutomation } from "./access";
import { itemQuestion } from "./question-content";

// A run's task lists at most this many open questions of earlier runs.
const OPEN_AUTOMATION_QUESTION_LIMIT = 20;

/**
 * List the open questions that the runs of one Automation asked, oldest
 * first, by item id and title. A later run of the Automation gets them in
 * its task, so it changes one by its id instead of asking it again.
 */
export async function listOpenAutomationQuestions(
  db: JuniorDatabase,
  automationId: string,
): Promise<Array<{ id: string; title: string }>> {
  return await db
    .select({ id: juniorInboxItems.id, title: juniorQuestions.title })
    .from(juniorInboxItems)
    .innerJoin(juniorQuestions, itemQuestion)
    .where(
      and(
        eq(juniorInboxItems.status, "open"),
        inboxItemAddedByAutomation(automationId),
      ),
    )
    .orderBy(asc(juniorInboxItems.createdAt), asc(juniorInboxItems.id))
    .limit(OPEN_AUTOMATION_QUESTION_LIMIT);
}
