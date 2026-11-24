/**
 * Patches that read the merge state and check counts of a pull request a
 * short time after a push or a check event, and write only those fields
 * into its cache entry.
 *
 * GitHub computes mergeability shortly after a push, so a webhook often
 * says `mergeable: null`, and check events carry no counts. The entry then
 * shows both as `pending` until a patch reads them. A patch waits in plugin
 * state, and the heartbeat runs the due ones, so the wait survives the end
 * of the webhook request. Events for one pull request inside the wait share
 * one patch. A patch names its pull request by the repository and number
 * of its cache key, and reads like the cards of a page
 * (`pull-request-prefetch.ts`).
 */
import type {
  EventPublisher,
  PluginCache,
  PluginLogger,
  PluginState,
} from "@sentry/junior-plugin-api";
import pLimit from "p-limit";
import * as z from "zod";
import {
  GITHUB_PULL_REQUEST_CACHE,
  GITHUB_PULL_REQUEST_PENDING_CACHE,
  type GitHubPullRequestFields,
  isOlderGitHubObject,
} from "./object-cache.js";
import {
  markGitHubConflict,
  publishGitHubConflictResolved,
} from "./merge-conflict-checks/resolved.js";
import {
  aliasedPullRequests,
  githubCheckCounts,
  githubMergeable,
  loadInHalves,
  pullRequestChunks,
  pullRequestHeadFactsNodeSchema,
  type PullRequestRef,
  pullRequestRefFromCacheKey,
} from "./pull-request-graphql.js";

/** Time from the first event to its patch. Later events keep this time. */
const PULL_REQUEST_PATCH_DELAY_MS = 5_000;

// A patch reads again while GitHub still computes mergeability, up to this
// many times. The heartbeat runs about once a minute.
const PATCH_MAX_ATTEMPTS = 5;
// The patches that one heartbeat runs, in queries of 25, and the queries
// that run at once.
const PATCHES_PER_HEARTBEAT = 100;
const PATCH_QUERY_CONCURRENCY = 4;
const PATCHES_KEY = "pull-request-patches";
// A patch list that nobody writes for this long was lost with its patches.
const PATCHES_TTL_MS = 60 * 60_000;
const LOCK_TTL_MS = 30_000;
const LOCK_WAIT_MS = 5_000;

// A patch saved before reads by repository and number also has a
// `nodeId`, which parsing leaves out.
const patchSchema = z.object({
  attempts: z.number().int().nonnegative(),
  dueAtMs: z.number(),
});
const patchesSchema = z.record(z.string(), patchSchema);
type Patches = z.output<typeof patchesSchema>;

async function changePatches<T>(
  state: PluginState,
  change: (patches: Patches) => T,
): Promise<T> {
  const result = await state.withLock(
    `${PATCHES_KEY}:lock`,
    LOCK_TTL_MS,
    async () => {
      const parsed = patchesSchema.safeParse(await state.get(PATCHES_KEY));
      const patches = parsed.success ? parsed.data : {};
      const value = change(patches);
      await state.set(PATCHES_KEY, patches, PATCHES_TTL_MS);
      return value;
    },
    { waitMs: LOCK_WAIT_MS },
  );
  if (!result.acquired) throw new Error("GitHub patch list is locked");
  return result.value;
}

/**
 * Add a patch for the pull request in cache entry `key`. A patch that
 * already waits keeps its time, so a burst of pushes makes one query. Its
 * attempts start again, because each event can start a new computation.
 * The heartbeat runs due patches. Once plugin tasks run on Queues
 * (getsentry/junior#4109), this becomes one delayed plugin task per pull
 * request and head commit.
 */
export async function scheduleGitHubPullRequestPatch(args: {
  key: string;
  nowMs: number;
  state: PluginState;
}): Promise<void> {
  await changePatches(args.state, (patches) => {
    patches[args.key] = {
      attempts: 0,
      dueAtMs:
        patches[args.key]?.dueAtMs ?? args.nowMs + PULL_REQUEST_PATCH_DELAY_MS,
    };
  });
}

type HeadFactsNode = z.output<typeof pullRequestHeadFactsNodeSchema>;

// Write the read fields, only over an entry of the same head commit that
// is not newer than the read. Return whether it wrote, and whether to read
// again: GitHub still computes the merge state, or a webhook came after the
// read and its fields still wait. After the last attempt, a merge state that
// GitHub still computes stays pending only briefly, so the next read asks
// GitHub.
async function writeHeadFacts(
  cache: PluginCache,
  key: string,
  node: HeadFactsNode,
  last: boolean,
): Promise<{ readAgain: boolean; written: boolean }> {
  const mergeable = githubMergeable(node.mergeable);
  let readAgain = false;
  let written = false;
  await cache.update<GitHubPullRequestFields | null>(key, (current) => {
    if (!current || current.head?.sha !== node.headRefOid) return undefined;
    if (isOlderGitHubObject(current, { updated_at: node.updatedAt })) {
      readAgain =
        current.checks === "pending" || current.mergeable === "pending";
      return undefined;
    }
    const computing = mergeable === null && current.mergeable === "pending";
    readAgain = computing && !last;
    written = true;
    return {
      ...(computing && last
        ? GITHUB_PULL_REQUEST_PENDING_CACHE
        : GITHUB_PULL_REQUEST_CACHE),
      value: {
        ...current,
        checks: githubCheckCounts(node.commits),
        // A check event leaves a known merge state as it is.
        mergeable: mergeable ?? current.mergeable,
      },
    };
  });
  return { readAgain, written };
}

// A patch reads the merge state that a push or a new base changes, so it
// also marks a conflict and publishes its fix
// (`merge-conflict-checks/resolved.ts`). A failure is logged, and the mark
// waits for the next read.
async function observeMergeState(
  args: {
    events: Pick<EventPublisher, "publish">;
    log: PluginLogger;
    state: PluginState;
  },
  ref: PullRequestRef,
  node: HeadFactsNode,
): Promise<void> {
  const mergeable = githubMergeable(node.mergeable);
  const pullRequest = {
    number: ref.number,
    repositoryFullName: `${ref.owner}/${ref.name}`,
  };
  try {
    if (mergeable === false) {
      await markGitHubConflict(args.state, pullRequest);
    } else if (mergeable === true) {
      await publishGitHubConflictResolved({
        events: args.events,
        headSha: node.headRefOid,
        ref: pullRequest,
        state: args.state,
      });
    }
  } catch (error) {
    args.log.error(
      "GitHub merge conflict mark failed",
      { number: ref.number, repository: pullRequest.repositoryFullName },
      error,
    );
  }
}

// A dropped patch leaves its pending fields fresh only briefly, so the
// next read loads the entry from GitHub. The stale copy stays for errors.
async function expirePending(cache: PluginCache, key: string): Promise<void> {
  await cache.update<GitHubPullRequestFields | null>(key, (current) =>
    current?.checks === "pending" || current?.mergeable === "pending"
      ? { ...GITHUB_PULL_REQUEST_PENDING_CACHE, value: current }
      : undefined,
  );
}

/**
 * Run the due patches: one query reads the merge state and checks of up
 * to 25 pull requests, and a failed query splits in halves. A patch whose
 * merge state GitHub still computes, whose read is older than its entry,
 * or whose query fails alone, waits for the next heartbeat. A patch with
 * no pull request in the answer, or out of attempts, is dropped, and its
 * entry is read again soon. A failed query is logged, not thrown, so the
 * rest of the heartbeat still runs.
 */
export async function runGitHubPullRequestPatches(args: {
  cache: PluginCache;
  events: Pick<EventPublisher, "publish">;
  loadHeadFacts(refs: PullRequestRef[]): Promise<unknown>;
  log: PluginLogger;
  nowMs: number;
  state: PluginState;
}): Promise<void> {
  const due = await changePatches(args.state, (patches) => {
    const taken = Object.entries(patches)
      .filter(([, patch]) => patch.dueAtMs <= args.nowMs)
      .slice(0, PATCHES_PER_HEARTBEAT);
    for (const [key] of taken) delete patches[key];
    return taken;
  });
  if (due.length === 0) return;
  type Due = (typeof due)[number];
  const again: Due[] = [];
  const dropped: string[] = [];
  const observed: { node: HeadFactsNode; ref: PullRequestRef }[] = [];
  const reads = due.flatMap(([key, patch]) => {
    const ref = pullRequestRefFromCacheKey(key);
    if (!ref) dropped.push(key);
    return ref ? [{ due: [key, patch] satisfies Due, ref }] : [];
  });
  // The queries of every chunk and of its halves share one limit.
  const queries = pLimit(PATCH_QUERY_CONCURRENCY);
  await pLimit(PATCH_QUERY_CONCURRENCY).map(
    pullRequestChunks(reads),
    async (chunk) =>
      await loadInHalves({
        failed: async ([read], error) => {
          if (!read) return;
          again.push(read.due);
          args.log.error(
            "GitHub pull request patch query failed",
            {
              number: read.ref.number,
              repository: `${read.ref.owner}/${read.ref.name}`,
            },
            error,
          );
        },
        items: chunk,
        load: async (part) => {
          // Answer `p<i>` is the pull request of `part[i]`.
          const nodes = aliasedPullRequests(
            await queries(() =>
              args.loadHeadFacts(part.map((read) => read.ref)),
            ),
            part.length,
            pullRequestHeadFactsNodeSchema,
          );
          for (const [index, { due: entry, ref }] of part.entries()) {
            const [key, patch] = entry;
            const node = nodes[index];
            if (!node) {
              dropped.push(key);
              continue;
            }
            const last = patch.attempts + 1 >= PATCH_MAX_ATTEMPTS;
            // oxlint-disable-next-line no-await-in-loop -- Each write takes its own entry lock; patches are few.
            const write = await writeHeadFacts(args.cache, key, node, last);
            // A read that the entry rejects is stale: a newer push or webhook
            // came after it, so its merge state must not mark or publish.
            if (write.written) observed.push({ node, ref });
            if (write.readAgain) {
              again.push(entry);
            }
          }
        },
      }),
  );
  for (const { node, ref } of observed) {
    // oxlint-disable-next-line no-await-in-loop -- Publish in order; only a mark or a fix writes.
    await observeMergeState(args, ref, node);
  }
  const retries = again.filter(
    ([, patch]) => patch.attempts + 1 < PATCH_MAX_ATTEMPTS,
  );
  const retried = new Set(retries.map(([key]) => key));
  const expired = [...dropped, ...again.map(([key]) => key)].filter(
    (key) => !retried.has(key),
  );
  for (const key of new Set(expired)) {
    // oxlint-disable-next-line no-await-in-loop -- Each write takes its own entry lock; patches are few.
    await expirePending(args.cache, key);
  }
  if (retries.length > 0) {
    await changePatches(args.state, (patches) => {
      for (const [key, patch] of retries) {
        // A newer event already added its own patch.
        patches[key] ??= { ...patch, attempts: patch.attempts + 1 };
      }
    });
  }
}
