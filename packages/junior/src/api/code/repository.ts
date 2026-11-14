import { and, desc, eq, sql } from "drizzle-orm";
import { getDb } from "@/chat/db";
import { listWorkspacesByRepository } from "@/chat/workspaces/store";
import { juniorCodeChanges, juniorCodeRepositories } from "@/db/schema";
import type { CodeChangeState } from "@sentry/junior-plugin-api";
import {
  codeRepositoryReportSchema,
  type CodeRepositoryReport,
} from "../schema/code";
import {
  codeChangeReport,
  codeChangeReportColumns,
  readCodeWindows,
} from "./overview";

/** Most recent code changes listed on one repository page. */
const REPOSITORY_CHANGE_LIMIT = 100;

function countState(state: CodeChangeState) {
  return sql<number>`count(${juniorCodeChanges.id}) filter (where ${juniorCodeChanges.state} = ${state})`.mapWith(
    Number,
  );
}

/**
 * Read code activity for one repository: windowed summary, activity buckets,
 * recent code changes, change counts by state, and the Workspaces that
 * include it. `state` limits the listed changes; the counts cover every
 * change.
 */
export async function readCodeRepository(
  repositoryId: string,
  options: { nowMs?: number; state?: CodeChangeState } = {},
): Promise<CodeRepositoryReport | undefined> {
  const nowMs = options.nowMs ?? Date.now();
  const db = getDb();
  // The state counts ride on the repository lookup, so they add no round
  // trip.
  const [row] = await db
    .select({
      closed: countState("closed"),
      id: juniorCodeRepositories.id,
      merged: countState("merged"),
      name: juniorCodeRepositories.name,
      open: countState("open"),
      provider: juniorCodeRepositories.provider,
      url: juniorCodeRepositories.url,
    })
    .from(juniorCodeRepositories)
    .leftJoin(
      juniorCodeChanges,
      eq(juniorCodeChanges.repositoryId, juniorCodeRepositories.id),
    )
    .where(eq(juniorCodeRepositories.id, repositoryId))
    .groupBy(juniorCodeRepositories.id);
  if (!row) return undefined;
  const { closed, merged, open, ...repository } = row;
  const [windows, changes, workspaces] = await Promise.all([
    readCodeWindows({ nowMs, repositoryId }),
    db
      .select(codeChangeReportColumns)
      .from(juniorCodeChanges)
      .innerJoin(
        juniorCodeRepositories,
        eq(juniorCodeChanges.repositoryId, juniorCodeRepositories.id),
      )
      .where(
        and(
          eq(juniorCodeChanges.repositoryId, repositoryId),
          options.state
            ? eq(juniorCodeChanges.state, options.state)
            : undefined,
        ),
      )
      .orderBy(desc(juniorCodeChanges.updatedAt))
      .limit(REPOSITORY_CHANGE_LIMIT),
    listWorkspacesByRepository(db, {
      provider: repository.provider,
      repo: repository.name,
    }),
  ]);
  return codeRepositoryReportSchema.parse({
    activityDays: windows.activityDays,
    activityHours: windows.activityHours,
    activitySixHours: windows.activitySixHours,
    changeCounts: { closed, merged, open },
    changes: changes.map(codeChangeReport),
    generatedAt: windows.windowEnd.toISOString(),
    repository: {
      ...repository,
      url: repository.url ?? undefined,
    },
    summary: windows.summary,
    windowEnd: windows.windowEnd.toISOString(),
    windowStart: windows.windowStart.toISOString(),
    workspaces,
  });
}
