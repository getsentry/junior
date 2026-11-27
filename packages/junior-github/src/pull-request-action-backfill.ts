/**
 * One-off backfill of the next action of open Junior PRs that went quiet
 * before a derivation rule shipped. Each syncs once through the webhook path,
 * which keeps an item whose saved action holds, also a dismissed one. A page
 * a webhook was checking runs again. Bump `VERSION` for a new rule, and set
 * `ASK_AFTER_REQUESTER_ACTED` to whether it asks after the requester acted.
 */
import type {
  PluginStartedTaskDefinition,
  PluginState,
  PluginTaskStarter,
} from "@sentry/junior-plugin-api";
import * as z from "zod";
import type { GitHubInstallationEnv } from "./webhooks/installation-requests.js";
import {
  startedTaskSyncContext,
  syncGitHubPullRequestActions,
} from "./webhooks/pull-request-action.js";

export const GITHUB_PULL_REQUEST_ACTION_BACKFILL_TASK =
  "backfillPullRequestActions";

const VERSION = "v2";
// The merge access rule of this version asks in limbo as a webhook does.
const ASK_AFTER_REQUESTER_ACTED = false;
const CURSOR_KEY = `pull-request-action-backfill:${VERSION}:cursor`;
const DONE_KEY = `pull-request-action-backfill:${VERSION}:done`;
// How often a page ran again, so its next run has a new task key.
const RERUNS_KEY = `pull-request-action-backfill:${VERSION}:reruns`;

/**
 * Pull requests per task run. Most need no GitHub read, because no person
 * asked for them. The others read GitHub a few times each, five at once, so
 * one run stays well inside the function time and the hourly rate limit.
 */
const PAGE_SIZE = 50;

const payloadSchema = z.object({}).strict();

/** Start the next page of the backfill until the last page is done. */
export async function startGitHubPullRequestActionBackfill(args: {
  state: PluginState;
  tasks: PluginTaskStarter;
}): Promise<void> {
  if (await args.state.get(DONE_KEY)) return;
  // One key per page, so a page that is done does not hold back the next.
  const after = await args.state.get<number>(CURSOR_KEY);
  const reruns = await args.state.get<number>(RERUNS_KEY);
  await args.tasks.start({
    key: `pull-request-action-backfill:${VERSION}:${after ?? 0}:${reruns ?? 0}`,
    name: GITHUB_PULL_REQUEST_ACTION_BACKFILL_TASK,
    payload: {},
  });
}

/**
 * Sync the next action of the next page of open Junior pull requests, in
 * the order of their GitHub ids. A failure for one pull request is logged
 * and skips it.
 */
export function githubPullRequestActionBackfillTask(args: {
  botEmail: () => string | undefined;
  env: Omit<GitHubInstallationEnv, "responses" | "tokens">;
}): PluginStartedTaskDefinition<typeof payloadSchema> {
  return {
    payload: payloadSchema,
    async run(ctx) {
      if (await ctx.state.get(DONE_KEY)) return;
      const after = (await ctx.state.get<number>(CURSOR_KEY)) ?? 0;
      const page = (await ctx.codeChanges.list({ state: "open" }))
        .map((change) => ({ change, id: Number(change.providerId) }))
        .filter(({ id }) => id > after)
        .sort((a, b) => a.id - b.id)
        .slice(0, PAGE_SIZE);
      const busy = await syncGitHubPullRequestActions({
        askAfterRequesterActed: ASK_AFTER_REQUESTER_ACTED,
        ...startedTaskSyncContext(ctx, {
          botEmail: args.botEmail(),
          env: args.env,
        }),
        deliveryId: `pull-request-action-backfill:${VERSION}`,
        targets: page.map(({ change }) => ({
          number: change.number,
          repositoryFullName: change.repository.name,
        })),
      });
      const last = page.at(-1);
      if (busy.length > 0) {
        // A page that syncs again changes only what is not saved yet.
        await ctx.state.set(
          RERUNS_KEY,
          ((await ctx.state.get<number>(RERUNS_KEY)) ?? 0) + 1,
        );
      } else if (!last || page.length < PAGE_SIZE) {
        await ctx.state.set(DONE_KEY, true);
      } else {
        await ctx.state.set(CURSOR_KEY, last.id);
      }
    },
  };
}
