/**
 * The `push` webhook part of merge conflict checks. It makes no GitHub API
 * calls. It schedules one check job per repository and time bucket, so a
 * burst of pushes gives one check, and GitHub has time to calculate
 * mergeability.
 */
import type { PluginJobScheduler } from "@sentry/junior-plugin-api";
import { and, eq } from "drizzle-orm";
import * as z from "zod";
import type { GitHubDb } from "../db/database.js";
import { juniorGitHubPullRequests } from "../db/schema.js";
import { MERGE_CONFLICT_CHECK_JOB } from "./job.js";

/** Time from a push to its check, and the length of one time bucket. */
const CONFLICT_CHECK_DELAY_MS = 2 * 60_000;

const pushSchema = z.object({
  deleted: z.boolean().optional(),
  ref: z.string(),
  repository: z.object({
    default_branch: z.string().min(1),
    full_name: z.string().min(1),
  }),
});

/**
 * Schedule a check after a push to a repository's default branch. Stacked
 * pull requests do not need this, because Junior restacks them when it
 * pushes the branch below. Return whether a check is scheduled.
 */
export async function scheduleGitHubPushConflictCheck(args: {
  body: unknown;
  db: GitHubDb;
  jobs: PluginJobScheduler;
  now: Date;
}): Promise<boolean> {
  const parsed = pushSchema.safeParse(args.body);
  if (
    !parsed.success ||
    parsed.data.deleted ||
    parsed.data.ref !== `refs/heads/${parsed.data.repository.default_branch}`
  ) {
    return false;
  }
  const repositoryFullName = parsed.data.repository.full_name;
  // Only a repository with an open Junior pull request needs a check.
  const t = juniorGitHubPullRequests;
  const [open] = await args.db
    .select({ number: t.number })
    .from(t)
    .where(
      and(eq(t.repositoryFullName, repositoryFullName), eq(t.state, "open")),
    )
    .limit(1);
  if (!open) return false;
  const bucket = Math.floor(args.now.getTime() / CONFLICT_CHECK_DELAY_MS);
  await args.jobs.schedule({
    delayMs: CONFLICT_CHECK_DELAY_MS,
    key: `${repositoryFullName}:${bucket}`,
    name: MERGE_CONFLICT_CHECK_JOB,
    payload: { attempt: 1, repositoryFullName },
  });
  return true;
}
