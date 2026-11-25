/**
 * A one-off backfill of the requesters of Junior pull requests in Junior's
 * code index.
 *
 * Code · Mine lists a person's code changes, including the ones that credit
 * them as requester. Requesters reach a code change when one is saved or
 * when its lifecycle webhook records it, so a pull request from before that
 * had none. This task credits the saved requesters of every pull request,
 * open, merged, or closed, from the stored rows only, with no GitHub reads.
 *
 * The heartbeat starts one page at a time until the last page is done.
 */
import type {
  PluginStartedTaskDefinition,
  PluginState,
  PluginTaskStarter,
} from "@sentry/junior-plugin-api";
import * as z from "zod";
import { gitHubDbSchema } from "../db/database.js";
import { syncGitHubPullRequestRequesters } from "./code-index.js";
import {
  type GitHubPullRequestRef,
  listGitHubPullRequestsWithRequesters,
} from "./store.js";

export const GITHUB_PULL_REQUEST_REQUESTER_BACKFILL_TASK =
  "backfillPullRequestRequesters";

const CURSOR_KEY = "pull-request-requester-backfill:cursor";
const DONE_KEY = "pull-request-requester-backfill:done";

/** Pull requests per task run. Each needs a few small database writes. */
const PAGE_SIZE = 200;

const payloadSchema = z.object({}).strict();

/** Start the next page of the backfill until the last page is done. */
export async function startGitHubPullRequestRequesterBackfill(args: {
  state: PluginState;
  tasks: PluginTaskStarter;
}): Promise<void> {
  if (await args.state.get(DONE_KEY)) return;
  // One key per page, so a page that is done does not hold back the next.
  const after = await args.state.get<GitHubPullRequestRef>(CURSOR_KEY);
  await args.tasks.start({
    key: `pull-request-requester-backfill:${after ? `${after.repositoryFullName}#${after.number}` : "start"}`,
    name: GITHUB_PULL_REQUEST_REQUESTER_BACKFILL_TASK,
    payload: {},
  });
}

/**
 * Credit the saved requesters of the next page of pull requests on their
 * code changes, in the order of repository name and number.
 */
export const githubPullRequestRequesterBackfillTask: PluginStartedTaskDefinition<
  typeof payloadSchema
> = {
  payload: payloadSchema,
  async run(ctx) {
    if (await ctx.state.get(DONE_KEY)) return;
    const db = gitHubDbSchema.parse(ctx.db);
    const page = await listGitHubPullRequestsWithRequesters(db, {
      after: await ctx.state.get<GitHubPullRequestRef>(CURSOR_KEY),
      limit: PAGE_SIZE,
    });
    const numbers = new Map<string, number[]>();
    for (const ref of page) {
      numbers.set(ref.repositoryFullName, [
        ...(numbers.get(ref.repositoryFullName) ?? []),
        ref.number,
      ]);
    }
    for (const [repositoryFullName, repositoryNumbers] of numbers) {
      // oxlint-disable-next-line no-await-in-loop -- One repository at a time keeps the page's writes in order.
      await syncGitHubPullRequestRequesters({
        codeChanges: ctx.codeChanges,
        db,
        numbers: repositoryNumbers,
        repositoryFullName,
      });
    }
    const last = page.at(-1);
    if (!last || page.length < PAGE_SIZE) {
      await ctx.state.set(DONE_KEY, true);
    } else {
      await ctx.state.set(CURSOR_KEY, last);
    }
  },
};
