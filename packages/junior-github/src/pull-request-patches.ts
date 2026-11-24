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
 * one patch, and one query reads up to 100 patches.
 */
import type { PluginCache, PluginState } from "@sentry/junior-plugin-api";
import * as z from "zod";
import {
  GITHUB_PULL_REQUEST_CACHE,
  type GitHubPullRequestFields,
  isOlderGitHubObject,
} from "./object-cache.js";
import {
  GITHUB_NODES_MAX,
  githubCheckCounts,
  githubMergeable,
  githubPullRequestNodes,
  pullRequestHeadFactsNodeSchema,
} from "./pull-request-graphql.js";

/** Time from the first event to its patch. Later events keep this time. */
const PULL_REQUEST_PATCH_DELAY_MS = 5_000;

// A patch reads again while GitHub still computes mergeability, up to this
// many times. The heartbeat runs about once a minute.
const PATCH_MAX_ATTEMPTS = 5;
const PATCHES_KEY = "pull-request-patches";
// A patch list that nobody writes for this long was lost with its patches.
const PATCHES_TTL_MS = 60 * 60_000;
const LOCK_TTL_MS = 30_000;
const LOCK_WAIT_MS = 5_000;

const patchSchema = z.object({
  attempts: z.number().int().nonnegative(),
  dueAtMs: z.number(),
  nodeId: z.string().min(1),
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
  nodeId: string;
  nowMs: number;
  state: PluginState;
}): Promise<void> {
  await changePatches(args.state, (patches) => {
    patches[args.key] = {
      attempts: 0,
      dueAtMs:
        patches[args.key]?.dueAtMs ?? args.nowMs + PULL_REQUEST_PATCH_DELAY_MS,
      nodeId: args.nodeId,
    };
  });
}

type HeadFactsNode = z.output<typeof pullRequestHeadFactsNodeSchema>;

// Write the read fields, only over an entry of the same head commit that
// is not newer than the read. Return whether GitHub still computes the
// merge state. After the last attempt, the merge state is unknown, not
// pending.
async function writeHeadFacts(
  cache: PluginCache,
  key: string,
  node: HeadFactsNode,
  last: boolean,
): Promise<boolean> {
  const mergeable = githubMergeable(node.mergeable);
  let computing = false;
  await cache.update<GitHubPullRequestFields | null>(key, (current) => {
    if (
      !current ||
      current.head?.sha !== node.headRefOid ||
      isOlderGitHubObject(current, { updated_at: node.updatedAt })
    ) {
      return undefined;
    }
    computing = mergeable === null && current.mergeable === "pending" && !last;
    return {
      ...GITHUB_PULL_REQUEST_CACHE,
      value: {
        ...current,
        checks: githubCheckCounts(node.commits),
        // A check event leaves a known merge state as it is.
        mergeable:
          mergeable ??
          (computing || current.mergeable !== "pending"
            ? current.mergeable
            : null),
      },
    };
  });
  return computing;
}

/**
 * Run the due patches: one query reads the merge state and checks of up
 * to 100 pull requests. A patch whose merge state GitHub still computes,
 * or whose query fails, waits for the next heartbeat.
 */
export async function runGitHubPullRequestPatches(args: {
  cache: PluginCache;
  loadHeadFacts(nodeIds: string[]): Promise<unknown>;
  nowMs: number;
  state: PluginState;
}): Promise<void> {
  const due = await changePatches(args.state, (patches) => {
    const taken = Object.entries(patches)
      .filter(([, patch]) => patch.dueAtMs <= args.nowMs)
      .slice(0, GITHUB_NODES_MAX);
    for (const [key] of taken) delete patches[key];
    return taken;
  });
  if (due.length === 0) return;
  const again: typeof due = [];
  try {
    const nodes = new Map(
      githubPullRequestNodes(
        await args.loadHeadFacts(due.map(([, patch]) => patch.nodeId)),
        pullRequestHeadFactsNodeSchema,
      ).map((node) => [node.id, node]),
    );
    for (const [key, patch] of due) {
      const node = nodes.get(patch.nodeId);
      const last = patch.attempts + 1 >= PATCH_MAX_ATTEMPTS;
      // oxlint-disable-next-line no-await-in-loop -- Each write takes its own entry lock; patches are few.
      if (node && (await writeHeadFacts(args.cache, key, node, last))) {
        again.push([key, patch]);
      }
    }
  } catch (error) {
    again.push(...due);
    throw error;
  } finally {
    const retries = again.filter(
      ([, patch]) => patch.attempts + 1 < PATCH_MAX_ATTEMPTS,
    );
    if (retries.length > 0) {
      await changePatches(args.state, (patches) => {
        for (const [key, patch] of retries) {
          // A newer event already added its own patch.
          patches[key] ??= { ...patch, attempts: patch.attempts + 1 };
        }
      });
    }
  }
}
