/**
 * Merge conflict checks that wait for the heartbeat, one per repository.
 *
 * A check is only a debounce, so it lives in plugin state, not in the
 * database. When a check is lost, the next push or pull request event
 * checks again. A push to the default branch adds a check, and a check
 * that already waits keeps its time. The heartbeat reads GitHub later, so a
 * burst of pushes gives one check, and GitHub has time to calculate
 * mergeability.
 */
import type { PluginState } from "@sentry/junior-plugin-api";
import { and, eq } from "drizzle-orm";
import * as z from "zod";
import type { GitHubDb } from "../db/database.js";
import { juniorGitHubPullRequests } from "../db/schema.js";

/** A key that waits longer than this was lost and expires. */
const CHECK_TTL_MS = 30 * 60_000;

/**
 * The heartbeat's own record of a running or repeated check. Only the
 * heartbeat writes it, so it needs no lock.
 */
const repeatSchema = z.object({
  /** Checks since the last push that ended with an unknown answer. */
  attempts: z.number().int().positive(),
  dueAtMs: z.number(),
});

type StoredRepeat = z.output<typeof repeatSchema>;

/** One claimed check. */
export interface GitHubConflictCheck {
  attempts: number;
  repositoryFullName: string;
}

// Two keys keep every write safe without a lock. Only the push webhook adds
// the push key, and `setIfNotExists` keeps the earliest due time. Only the
// heartbeat writes the repeat key.
function pushKey(repositoryFullName: string): string {
  return `merge-conflict-check:push:${repositoryFullName}`;
}

function repeatKey(repositoryFullName: string): string {
  return `merge-conflict-check:repeat:${repositoryFullName}`;
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
  await args.state.setIfNotExists(
    pushKey(args.repositoryFullName),
    args.dueAtMs,
    CHECK_TTL_MS,
  );
  return true;
}

/**
 * Claim the due check of a repository. The claim removes the push key
 * before the check reads GitHub, so the read includes every push that the
 * key held, and a later push adds a new key. A repeat at `claimedUntilMs`
 * runs the check again when it stops without an end.
 */
export async function claimGitHubConflictCheck(args: {
  claimedUntilMs: number;
  nowMs: number;
  repositoryFullName: string;
  state: PluginState;
}): Promise<GitHubConflictCheck | undefined> {
  const pushDueAtMs = await args.state.get<number>(
    pushKey(args.repositoryFullName),
  );
  const repeat = repeatSchema.safeParse(
    await args.state.get(repeatKey(args.repositoryFullName)),
  );
  let attempts: number;
  if (typeof pushDueAtMs === "number" && pushDueAtMs <= args.nowMs) {
    attempts = 1;
  } else if (repeat.success && repeat.data.dueAtMs <= args.nowMs) {
    attempts = repeat.data.attempts + 1;
  } else {
    return undefined;
  }
  await args.state.set(
    repeatKey(args.repositoryFullName),
    { attempts, dueAtMs: args.claimedUntilMs } satisfies StoredRepeat,
    CHECK_TTL_MS,
  );
  if (attempts === 1) await args.state.delete(pushKey(args.repositoryFullName));
  return { attempts, repositoryFullName: args.repositoryFullName };
}

/** End a claimed check, or repeat it at `retryAtMs`. */
export async function settleGitHubConflictCheck(
  state: PluginState,
  check: GitHubConflictCheck,
  retryAtMs?: number,
): Promise<void> {
  if (retryAtMs === undefined) {
    await state.delete(repeatKey(check.repositoryFullName));
    return;
  }
  await state.set(
    repeatKey(check.repositoryFullName),
    { attempts: check.attempts, dueAtMs: retryAtMs } satisfies StoredRepeat,
    CHECK_TTL_MS,
  );
}
