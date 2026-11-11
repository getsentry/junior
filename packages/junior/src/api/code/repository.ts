import { count, desc, eq, sql } from "drizzle-orm";
import { getDb } from "@/chat/db";
import { listWorkspacesByRepository } from "@/chat/workspaces/store";
import { juniorCodeChanges, juniorCodeRepositories } from "@/db/schema";
import {
  codeRepositoryReportSchema,
  type CodeRepositoryReport,
} from "../schema/code";
import {
  codeChangeReport,
  codeChangeReportColumns,
  readCodeWindows,
} from "./overview";

/**
 * Code changes listed on one repository page. Open changes sort first so a
 * stale open change is not cut off by newer completed changes.
 */
const REPOSITORY_CHANGE_LIMIT = 100;

/**
 * Read code activity for one repository: windowed summary, activity buckets,
 * recent code changes with every change counted by state, and the
 * Workspaces that include it.
 */
export async function readCodeRepository(
  repositoryId: string,
  nowMs = Date.now(),
): Promise<CodeRepositoryReport | undefined> {
  const db = getDb();
  const [repository] = await db
    .select({
      id: juniorCodeRepositories.id,
      name: juniorCodeRepositories.name,
      provider: juniorCodeRepositories.provider,
      url: juniorCodeRepositories.url,
    })
    .from(juniorCodeRepositories)
    .where(eq(juniorCodeRepositories.id, repositoryId))
    .limit(1);
  if (!repository) return undefined;
  const [windows, changes, stateCounts, workspaces] = await Promise.all([
    readCodeWindows({ nowMs, repositoryId }),
    db
      .select(codeChangeReportColumns)
      .from(juniorCodeChanges)
      .innerJoin(
        juniorCodeRepositories,
        eq(juniorCodeChanges.repositoryId, juniorCodeRepositories.id),
      )
      .where(eq(juniorCodeChanges.repositoryId, repositoryId))
      .orderBy(
        desc(sql`${juniorCodeChanges.state} = 'open'`),
        desc(juniorCodeChanges.updatedAt),
      )
      .limit(REPOSITORY_CHANGE_LIMIT),
    db
      .select({ count: count(), state: juniorCodeChanges.state })
      .from(juniorCodeChanges)
      .where(eq(juniorCodeChanges.repositoryId, repositoryId))
      .groupBy(juniorCodeChanges.state),
    listWorkspacesByRepository(db, {
      provider: repository.provider,
      repo: repository.name,
    }),
  ]);
  const countOf = (state: string) =>
    stateCounts.find((row) => row.state === state)?.count ?? 0;
  return codeRepositoryReportSchema.parse({
    activityDays: windows.activityDays,
    activityHours: windows.activityHours,
    activitySixHours: windows.activitySixHours,
    changeCounts: {
      closed: countOf("closed"),
      merged: countOf("merged"),
      open: countOf("open"),
    },
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
