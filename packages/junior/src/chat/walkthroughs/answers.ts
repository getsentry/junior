/**
 * Reviewer answers to Walkthrough decisions: one row per reviewer, version,
 * and decision. The dashboard builds review text from them.
 */
import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "@/chat/db";
import { juniorWalkthroughAnswers } from "@/db/schema";
import type { WalkthroughAnswerValue } from "@/db/schema/walkthroughs";

export type WalkthroughAnswer = typeof juniorWalkthroughAnswers.$inferSelect;

/**
 * Read one reviewer's answers across a lineage. Each decision keeps the
 * answer from the nearest version. `versionIds` is nearest first.
 */
export async function readWalkthroughLineageAnswers(input: {
  versionIds: readonly string[];
  userId: string;
}): Promise<WalkthroughAnswer[]> {
  if (input.versionIds.length === 0) return [];
  const rows = await getDb()
    .select()
    .from(juniorWalkthroughAnswers)
    .where(
      and(
        inArray(juniorWalkthroughAnswers.versionId, [...input.versionIds]),
        eq(juniorWalkthroughAnswers.userId, input.userId),
      ),
    );
  return nearestAnswers(rows, input.versionIds);
}

/**
 * Decisions whose latest answer from some reviewer asks for a change, across
 * a lineage. Only ids: a reviewer's notes stay private to them.
 */
export async function readChangeRequestedDecisionIds(
  versionIds: readonly string[],
): Promise<string[]> {
  if (versionIds.length === 0) return [];
  const rows = await getDb()
    .select()
    .from(juniorWalkthroughAnswers)
    .where(inArray(juniorWalkthroughAnswers.versionId, [...versionIds]));
  const byUser = new Map<string, WalkthroughAnswer[]>();
  for (const row of rows) {
    byUser.set(row.userId, [...(byUser.get(row.userId) ?? []), row]);
  }
  const ids = new Set<string>();
  for (const answers of byUser.values()) {
    for (const answer of nearestAnswers(answers, versionIds)) {
      if (answer.value === "change") ids.add(answer.decisionId);
    }
  }
  return [...ids].sort();
}

function nearestAnswers(
  rows: readonly WalkthroughAnswer[],
  versionIds: readonly string[],
): WalkthroughAnswer[] {
  const rank = new Map(versionIds.map((id, index) => [id, index]));
  const nearest = new Map<string, WalkthroughAnswer>();
  for (const row of rows) {
    const held = nearest.get(row.decisionId);
    if (!held || rank.get(row.versionId)! < rank.get(held.versionId)!) {
      nearest.set(row.decisionId, row);
    }
  }
  return [...nearest.values()];
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
