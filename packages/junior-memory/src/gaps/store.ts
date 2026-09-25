import { createHash } from "node:crypto";
import { and, desc, eq, gte, ilike, lt, or, sql } from "drizzle-orm";
import type { PluginRunContext } from "@sentry/junior-plugin-api";
import { z } from "zod";
import {
  juniorMemoryGapCaptures,
  juniorMemoryGaps as gaps,
} from "../db/schema";
import type { MemoryDb } from "../store";
import {
  GAP_CATEGORIES,
  GAP_IMPACTS,
  GAP_REVIEW_STATES,
  type ExtractedGap,
} from "./types";

const DAY_MS = 86_400_000;
export const gapListInputSchema = z
  .object({
    limit: z.number().int().min(1).max(50).default(25),
    cursor: z.string().max(1000).optional(),
    query: z.string().trim().max(200).optional(),
    category: z.enum(GAP_CATEGORIES).optional(),
    impact: z.enum(GAP_IMPACTS).optional(),
    reviewState: z.enum(GAP_REVIEW_STATES).optional(),
    days: z.number().int().min(1).max(365).optional(),
  })
  .strict();
const cursorSchema = z
  .object({
    id: z.string().min(1),
    observedAtMs: z.number().finite(),
  })
  .strict();
type Gap = typeof gaps.$inferSelect;

function visibleGaps(userId: string) {
  return or(eq(gaps.scope, "public"), eq(gaps.ownerUserId, userId));
}

/** Store a Turn's observations atomically, including a durable empty capture. */
export async function captureGaps(
  db: MemoryDb,
  run: PluginRunContext,
  proposals: ExtractedGap[],
): Promise<void> {
  // V1 follows passive memory coverage and requires one accountable owner.
  if (
    !run.actorUserId ||
    (run.source.kind !== "slack" && run.source.kind !== "web")
  )
    return;
  const ownerUserId = run.actorUserId;
  const observations: (typeof gaps.$inferInsert)[] = [];
  for (const proposal of proposals) {
    const indices = [...new Set(proposal.evidenceMessageIndices)].sort(
      (a, b) => a - b,
    );
    const entries = indices.map((index) => run.transcript[index]);
    if (entries.some((entry) => !entry)) continue;
    const hasRequest = entries.some(
      (entry) =>
        entry?.type === "message" &&
        entry.role === "user" &&
        entry.provenance?.authority === "instruction" &&
        entry.isRunActor === true,
    );
    const hasOutcome = entries.some(
      (entry) =>
        entry?.type === "toolResult" ||
        (entry?.type === "message" && entry.role === "assistant"),
    );
    if (!hasRequest || !hasOutcome) continue;
    const id = createHash("sha256")
      .update(
        `${run.runId}\0${proposal.category}\0${proposal.description.toLowerCase().replace(/\s+/g, " ")}`,
      )
      .digest("hex");
    observations.push({
      ...proposal,
      id,
      // The host's legacy runId field contains the completed Turn ID.
      turnId: run.runId,
      conversationId: run.conversationId,
      scope: run.source.visibility === "public" ? "public" : "private",
      ownerUserId,
      evidenceMessageIndices: indices,
      evidenceKind: entries.some((entry) => entry?.type === "toolResult")
        ? "tool"
        : "reported",
      observedAtMs: run.completedAtMs,
    });
  }
  await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(juniorMemoryGapCaptures)
      .values({
        turnId: run.runId,
        conversationId: run.conversationId,
        capturedAtMs: run.completedAtMs,
      })
      .onConflictDoNothing()
      .returning({ turnId: juniorMemoryGapCaptures.turnId });
    if (!inserted.length || !observations.length) return;
    await tx.insert(gaps).values(observations).onConflictDoNothing();
  });
}

/** List only observations the viewer can read; counts use distinct Turns. */
export async function listGaps(
  db: MemoryDb,
  userId: string,
  rawInput: z.input<typeof gapListInputSchema>,
) {
  const input = gapListInputSchema.parse(rawInput);
  const filters = [visibleGaps(userId)];
  if (input.category) filters.push(eq(gaps.category, input.category));
  if (input.impact) filters.push(eq(gaps.impact, input.impact));
  if (input.reviewState) filters.push(eq(gaps.reviewState, input.reviewState));
  if (input.days)
    filters.push(gte(gaps.observedAtMs, Date.now() - input.days * DAY_MS));
  if (input.query) {
    const search = `%${input.query.replace(/[\\%_]/g, "\\$&")}%`;
    filters.push(
      or(ilike(gaps.description, search), ilike(gaps.explanation, search)),
    );
  }
  const pageFilters = [...filters];
  if (input.cursor) {
    const decoded = Buffer.from(input.cursor, "base64url").toString("utf8");
    const parsed = z
      .string()
      .transform((value, ctx) => {
        try {
          return JSON.parse(value) as unknown;
        } catch {
          ctx.addIssue({ code: "custom", message: "Invalid gap cursor." });
          return z.NEVER;
        }
      })
      .pipe(cursorSchema)
      .parse(decoded);
    pageFilters.push(
      or(
        lt(gaps.observedAtMs, parsed.observedAtMs),
        and(eq(gaps.observedAtMs, parsed.observedAtMs), lt(gaps.id, parsed.id)),
      ),
    );
  }
  const [rows, counts] = await Promise.all([
    db
      .select()
      .from(gaps)
      .where(and(...pageFilters))
      .orderBy(desc(gaps.observedAtMs), desc(gaps.id))
      .limit(input.limit + 1),
    db
      .select({
        category: gaps.category,
        turns: sql<number>`count(distinct ${gaps.turnId})`.mapWith(Number),
      })
      .from(gaps)
      .where(and(...filters))
      .groupBy(gaps.category),
  ]);
  const page = rows.slice(0, input.limit);
  const last = page.at(-1);
  return {
    gaps: page,
    counts,
    nextCursor:
      rows.length > input.limit && last
        ? Buffer.from(
            JSON.stringify({ id: last.id, observedAtMs: last.observedAtMs }),
          ).toString("base64url")
        : undefined,
  };
}

/** Only the observation owner can change its review state, even when public. */
export async function reviewGap(
  db: MemoryDb,
  userId: string,
  id: string,
  reviewState: Gap["reviewState"],
): Promise<boolean> {
  const rows = await db
    .update(gaps)
    .set({ reviewState, reviewedByUserId: userId, reviewedAtMs: Date.now() })
    .where(and(eq(gaps.id, id), eq(gaps.ownerUserId, userId)))
    .returning({ id: gaps.id });
  return rows.length > 0;
}
