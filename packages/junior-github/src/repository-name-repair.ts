/**
 * A one-off repair of the repository names in Junior's code index.
 *
 * The GitHub migration 0020 kept the stored name of a repository that the
 * code index already had, so a repository renamed before it can still have
 * its old name. Reads that find a pull request by repository name miss it
 * until a lifecycle webhook records the new name. This task reads the
 * current name of each stored repository from GitHub by its id, once, and
 * records the names that changed. The repository's Annotations get the new
 * name too.
 */
import pLimit from "p-limit";
import type {
  PluginStartedTaskDefinition,
  PluginState,
  PluginTaskStarter,
} from "@sentry/junior-plugin-api";
import * as z from "zod";
import { githubRepositoryMove, orderRepositoryRenames } from "./annotations.js";

export const GITHUB_REPOSITORY_NAME_REPAIR_TASK = "repairRepositoryNames";

const DONE_KEY = "repository-name-repair:done";

/** GitHub reads at once. */
const READ_CONCURRENCY = 4;

const payloadSchema = z.object({}).strict();

/** Start the repair until one run finishes. */
export async function startGitHubRepositoryNameRepair(args: {
  state: PluginState;
  tasks: PluginTaskStarter;
}): Promise<void> {
  if (await args.state.get(DONE_KEY)) return;
  await args.tasks.start({
    key: "repository-name-repair",
    name: GITHUB_REPOSITORY_NAME_REPAIR_TASK,
    payload: {},
  });
}

/**
 * Record the current GitHub name of each stored repository whose name
 * changed. An error for one repository is logged and skips it. A repository
 * that GitHub does not find keeps its name.
 */
export function githubRepositoryNameRepairTask(
  loadFullNames: () => Promise<
    (repositoryId: string) => Promise<string | undefined>
  >,
): PluginStartedTaskDefinition<typeof payloadSchema> {
  return {
    payload: payloadSchema,
    async run(ctx) {
      if (await ctx.state.get(DONE_KEY)) return;
      const stored = new Map<string, string>();
      for (const change of await ctx.codeChanges.list({})) {
        stored.set(change.repository.providerId, change.repository.name);
      }
      if (stored.size > 0) {
        const readFullName = await loadFullNames();
        const updatedAt = new Date();
        const renames: [from: string, to: string][] = [];
        await pLimit(READ_CONCURRENCY).map(
          [...stored],
          async ([providerId, name]) => {
            try {
              const fullName = await readFullName(providerId);
              if (!fullName || fullName === name) return;
              await ctx.codeChanges.recordRepository({
                name: fullName,
                providerId,
                updatedAt,
              });
              renames.push([name, fullName]);
            } catch (error) {
              ctx.log.error(
                "GitHub repository name repair failed",
                { repositoryId: providerId },
                error,
              );
            }
          },
        );
        // A move rewrites every key under its old name, so moves run one at
        // a time, and a chain of renames runs from its newest name back.
        const { cyclic, ordered } = orderRepositoryRenames(renames);
        for (const [from, to] of ordered) {
          try {
            // oxlint-disable-next-line no-await-in-loop -- Few repositories move, and each move is one write.
            await ctx.annotations.objectsMoved(githubRepositoryMove(from, to));
          } catch (error) {
            ctx.log.error(
              "GitHub repository Annotation move failed",
              { from, to },
              error,
            );
          }
        }
        for (const [from, to] of cyclic) {
          ctx.log.error("GitHub repository renames form a cycle", { from, to });
        }
      }
      await ctx.state.set(DONE_KEY, true);
    },
  };
}
