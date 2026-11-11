/**
 * Reviewer answers to Walkthrough decisions: one row per reviewer, version,
 * and decision. The dashboard builds review text from them.
 */
import { and, eq } from "drizzle-orm";
import { getDb } from "@/chat/db";
import { juniorWalkthroughAnswers } from "@/db/schema";
import type { WalkthroughAnswerValue } from "@/db/schema/walkthroughs";

export type WalkthroughAnswer = typeof juniorWalkthroughAnswers.$inferSelect;

/** Read one reviewer's answers on one version. */
export async function readWalkthroughAnswers(input: {
  versionId: string;
  userId: string;
}): Promise<WalkthroughAnswer[]> {
  return await getDb()
    .select()
    .from(juniorWalkthroughAnswers)
    .where(
      and(
        eq(juniorWalkthroughAnswers.versionId, input.versionId),
        eq(juniorWalkthroughAnswers.userId, input.userId),
      ),
    );
}

/** Save a reviewer's answer to one decision. A new answer replaces the old one. */
export async function saveWalkthroughAnswer(input: {
  versionId: string;
  userId: string;
  decisionId: string;
  value: WalkthroughAnswerValue;
  note?: string;
}): Promise<WalkthroughAnswer> {
  const row = {
    versionId: input.versionId,
    userId: input.userId,
    decisionId: input.decisionId,
    value: input.value,
    note: input.note?.trim() || null,
    updatedAt: new Date(),
  };
  await getDb()
    .insert(juniorWalkthroughAnswers)
    .values(row)
    .onConflictDoUpdate({
      target: [
        juniorWalkthroughAnswers.versionId,
        juniorWalkthroughAnswers.userId,
        juniorWalkthroughAnswers.decisionId,
      ],
      set: { value: row.value, note: row.note, updatedAt: row.updatedAt },
    });
  return row;
}
