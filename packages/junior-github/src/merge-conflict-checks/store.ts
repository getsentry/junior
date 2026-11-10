/**
 * Merge conflict checks that wait for the heartbeat, one per repository.
 *
 * A check is only a debounce, so it lives in plugin state, not in the
 * database. When a check is lost, the next push or pull request event
 * checks again. A push to the default branch adds a check, or moves a
 * waiting check earlier. The heartbeat reads GitHub later, so a burst of
 * pushes gives one check, and GitHub has time to calculate mergeability.
 */
import type { PluginState } from "@sentry/junior-plugin-api";
import { and, eq } from "drizzle-orm";
import * as z from "zod";
import type { GitHubDb } from "../db/database.js";
import { juniorGitHubPullRequests } from "../db/schema.js";

/** A check that waits longer than this was lost and expires. */
const CHECK_TTL_MS = 30 * 60_000;

const checkSchema = z.object({
  /** Checks since the last push that ended with an unknown answer. */
  attempts: z.number().int().nonnegative(),
  dueAtMs: z.number(),
});

type StoredCheck = z.output<typeof checkSchema>;

/** One claimed check. `claimedUntilMs` identifies the claim. */
export interface GitHubConflictCheck {
  attempts: number;
  claimedUntilMs: number;
  repositoryFullName: string;
}

function checkKey(repositoryFullName: string): string {
  return `merge-conflict-check:${repositoryFullName}`;
}

async function readCheck(
  state: PluginState,
  repositoryFullName: string,
): Promise<StoredCheck | undefined> {
  const parsed = checkSchema.safeParse(
    await state.get(checkKey(repositoryFullName)),
  );
  return parsed.success ? parsed.data : undefined;
}

/** Return the numbers of the open Junior pull requests, by repository. */
export async function listOpenGitHubPullRequestNumbers(
  db: GitHubDb,
  repositoryFullName?: string,
): Promise<Map<string, number[]>> {
  const t = juniorGitHubPullRequests;
  const rows = await db
    .select({ number: t.number, repositoryFullName: t.repositoryFullName })
    .from(t)
    .where(
      and(
        eq(t.state, "open"),
        repositoryFullName
          ? eq(t.repositoryFullName, repositoryFullName)
          : undefined,
      ),
    )
    .orderBy(t.repositoryFullName, t.number);
  const numbers = new Map<string, number[]>();
  for (const row of rows) {
    numbers.set(row.repositoryFullName, [
      ...(numbers.get(row.repositoryFullName) ?? []),
      row.number,
    ]);
  }
  return numbers;
}

/**
 * Add a check at `dueAtMs` for a repository with open Junior pull requests.
 * A check that already waits keeps its earlier time, so pushes that keep
 * coming do not delay it. Return whether a check waits.
 */
export async function scheduleGitHubConflictCheck(args: {
  db: GitHubDb;
  dueAtMs: number;
  repositoryFullName: string;
  state: PluginState;
}): Promise<boolean> {
  const open = await listOpenGitHubPullRequestNumbers(
    args.db,
    args.repositoryFullName,
  );
  if (open.size === 0) return false;
  const waiting = await readCheck(args.state, args.repositoryFullName);
  // A claim is later than a new due time, so this also moves a running
  // check's claim earlier, and the running check does not remove it.
  if (!waiting || waiting.dueAtMs > args.dueAtMs) {
    await args.state.set(
      checkKey(args.repositoryFullName),
      { attempts: 0, dueAtMs: args.dueAtMs } satisfies StoredCheck,
      CHECK_TTL_MS,
    );
  }
  return true;
}

/**
 * Claim the due check of a repository. A claim moves the check to
 * `claimedUntilMs`, so a check that stops without an end runs again then.
 */
export async function claimGitHubConflictCheck(args: {
  claimedUntilMs: number;
  nowMs: number;
  repositoryFullName: string;
  state: PluginState;
}): Promise<GitHubConflictCheck | undefined> {
  const waiting = await readCheck(args.state, args.repositoryFullName);
  if (!waiting || waiting.dueAtMs > args.nowMs) return undefined;
  const attempts = waiting.attempts + 1;
  await args.state.set(
    checkKey(args.repositoryFullName),
    { attempts, dueAtMs: args.claimedUntilMs } satisfies StoredCheck,
    CHECK_TTL_MS,
  );
  return {
    attempts,
    claimedUntilMs: args.claimedUntilMs,
    repositoryFullName: args.repositoryFullName,
  };
}

/**
 * Remove a claimed check, or move it to `retryAtMs`. Does nothing when a
 * push moved the check during the claim.
 */
export async function settleGitHubConflictCheck(
  state: PluginState,
  check: GitHubConflictCheck,
  retryAtMs?: number,
): Promise<void> {
  const waiting = await readCheck(state, check.repositoryFullName);
  if (waiting?.dueAtMs !== check.claimedUntilMs) return;
  if (retryAtMs === undefined) {
    await state.delete(checkKey(check.repositoryFullName));
    return;
  }
  await state.set(
    checkKey(check.repositoryFullName),
    { attempts: check.attempts, dueAtMs: retryAtMs } satisfies StoredCheck,
    CHECK_TTL_MS,
  );
}
