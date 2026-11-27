/**
 * Patches that read the merge state and check counts of a pull request a
 * short time after a push or a check event, and write only those fields
 * into its cache entry.
 *
 * GitHub computes mergeability shortly after a push, so a webhook often
 * says `mergeable: null`, and check events carry no counts. The entry then
 * shows both as `pending` until a patch reads them. A patch is a plugin
 * task that starts 5 s after its event, so the wait survives the end of
 * the webhook request. Events for one head commit inside one 5 s window
 * share one task. A patch names its pull request by the repository and
 * number of its cache key, and reads like the cards of a page
 * (`pull-request-prefetch.ts`).
 */
import type {
  EventPublisher,
  PluginCache,
  PluginLogger,
  PluginStartedTaskDefinition,
  PluginState,
  PluginTaskStarter,
} from "@sentry/junior-plugin-api";
import * as z from "zod";
import {
  GITHUB_PULL_REQUEST_CACHE,
  GITHUB_PULL_REQUEST_PENDING_CACHE,
  type GitHubPullRequestFields,
  isOlderGitHubObject,
} from "./object-cache.js";
import { GITHUB_INBOX_SUBJECTS } from "./inbox-subjects.js";
import {
  markGitHubConflict,
  publishGitHubConflictResolved,
} from "./merge-conflict-checks/resolved.js";
import {
  aliasedPullRequests,
  githubCheckCounts,
  githubMergeable,
  pullRequestHeadFactsNodeSchema,
  type PullRequestRef,
  pullRequestRefFromCacheKey,
} from "./pull-request-graphql.js";

export const GITHUB_PULL_REQUEST_PATCH_TASK = "patchPullRequest";

// Time from an event to its patch, and the window of events that share it.
const PATCH_DELAY_SECONDS = 5;

const payloadSchema = z
  .object({
    /** Cache entry `pulls:owner/repo#N`. */
    key: z.string().min(1),
    /** Head commit of the event. */
    sha: z.string().min(1),
  })
  .strict();

/**
 * The patch read is not final yet: GitHub still computes the merge state,
 * or a webhook came after the read. The queue delivers the task again.
 */
class GitHubPullRequestPatchPendingError extends Error {
  constructor(key: string, sha: string) {
    super(`GitHub pull request ${key} at ${sha} has no final read yet`);
    this.name = "GitHubPullRequestPatchPendingError";
  }
}

/**
 * Start the patch of the pull request in cache entry `key`. A second event
 * for the same head commit in the same 5 s window does nothing, so a burst
 * makes one query. A later event starts a new patch with its own retries,
 * because each event can start a new computation.
 */
export async function startGitHubPullRequestPatch(args: {
  key: string;
  nowMs: number;
  sha: string;
  tasks: PluginTaskStarter;
}): Promise<void> {
  const window = Math.floor(args.nowMs / (PATCH_DELAY_SECONDS * 1000));
  await args.tasks.start({
    delaySeconds: PATCH_DELAY_SECONDS,
    key: `${args.key}:${args.sha}:${window}`,
    name: GITHUB_PULL_REQUEST_PATCH_TASK,
    payload: { key: args.key, sha: args.sha },
  });
}

// GitHub's id names the pull request in Annotations. GitHub's schema
// lets it be null, and the patch does not need it.
const headFactsNodeSchema = pullRequestHeadFactsNodeSchema.extend({
  databaseId: z.number().int().positive().nullish(),
});

type HeadFactsNode = z.output<typeof headFactsNodeSchema>;

// Write the read fields, only over an entry of the same head commit that
// is not newer than the read. Return `again` to read again: GitHub still
// computes the merge state, or a webhook came after the read and its
// fields still wait. Return `expire` when the read is of another head
// commit than the entry, as for a dropped patch. On the last delivery, a
// merge state that GitHub still computes stays pending only briefly, so
// the next read asks GitHub. `written` says whether the read was current.
async function writeHeadFacts(
  cache: PluginCache,
  key: string,
  node: HeadFactsNode,
  last: boolean,
): Promise<{
  changed: boolean;
  outcome: "again" | "done" | "expire";
  written: boolean;
}> {
  const mergeable = githubMergeable(node.mergeable);
  let outcome: "again" | "done" | "expire" = "done";
  let written = false;
  let changed = false;
  await cache.update<GitHubPullRequestFields | null>(key, (current) => {
    if (!current) return undefined;
    if (current.head?.sha !== node.headRefOid) {
      outcome = "expire";
      return undefined;
    }
    if (isOlderGitHubObject(current, { updated_at: node.updatedAt })) {
      if (current.checks === "pending" || current.mergeable === "pending") {
        outcome = "again";
      }
      return undefined;
    }
    const computing = mergeable === null && current.mergeable === "pending";
    if (computing && !last) outcome = "again";
    written = true;
    const value = {
      ...current,
      checks: githubCheckCounts(node.commits),
      // A check event leaves a known merge state as it is.
      mergeable: mergeable ?? current.mergeable,
    };
    changed =
      JSON.stringify([current.checks, current.mergeable]) !==
      JSON.stringify([value.checks, value.mergeable]);
    return {
      ...(computing && last
        ? GITHUB_PULL_REQUEST_PENDING_CACHE
        : GITHUB_PULL_REQUEST_CACHE),
      value,
    };
  });
  return { changed, outcome, written };
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
 * Read the merge state and checks of one pull request and write them into
 * its entry. While the read is not final, the task throws, and the queue
 * delivers it again with backoff. On the last delivery, a merge state
 * that GitHub still computes stays pending only briefly, so the next read
 * asks GitHub. A pull request missing from the answer, of another head
 * commit, or whose query fails on the last delivery, leaves its pending
 * fields fresh only briefly too. A change calls `objectChanged`.
 */
export function githubPullRequestPatchTask(
  loadHeadFacts: (refs: PullRequestRef[]) => Promise<unknown>,
): PluginStartedTaskDefinition<typeof payloadSchema> {
  return {
    payload: payloadSchema,
    async run(ctx) {
      const { key, sha } = ctx.payload;
      const ref = pullRequestRefFromCacheKey(key);
      if (!ref)
        throw new Error(`GitHub patch key ${key} names no pull request`);
      // A push since this task started has its own task, which owns the
      // entry now.
      const cached = await ctx.cache.get<GitHubPullRequestFields | null>(key);
      if (cached && cached.head?.sha !== sha) return;
      let node: HeadFactsNode | undefined;
      try {
        [node] = aliasedPullRequests(
          await loadHeadFacts([ref]),
          1,
          headFactsNodeSchema,
        );
      } catch (error) {
        if (ctx.lastDelivery) await expirePending(ctx.cache, key);
        throw error;
      }
      const write = node
        ? await writeHeadFacts(ctx.cache, key, node, ctx.lastDelivery)
        : undefined;
      // A read that the entry rejects is stale: a newer push or webhook
      // came after it, so its merge state must not mark or publish.
      if (node && write?.written) await observeMergeState(ctx, ref, node);
      if (node?.databaseId && write?.changed) {
        await ctx.annotations.objectChanged({
          id: String(node.databaseId),
          kind: GITHUB_INBOX_SUBJECTS.pullRequest,
        });
      }
      const outcome = write?.outcome ?? "expire";
      if (outcome === "again" && !ctx.lastDelivery) {
        throw new GitHubPullRequestPatchPendingError(key, sha);
      }
      if (outcome !== "done") await expirePending(ctx.cache, key);
    },
  };
}
