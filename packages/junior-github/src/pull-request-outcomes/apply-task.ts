/**
 * The task that applies a pull request outcome again when the webhook's
 * inline write fails. GitHub does not send a failed webhook again, so this
 * task is the retry. Its payload is the outcome in JSON form.
 */
import type { PluginStartedTaskDefinition } from "@sentry/junior-plugin-api";
import * as z from "zod";
import { gitHubDbSchema } from "../db/database.js";
import { applyGitHubPullRequestOutcome } from "./apply.js";
import {
  type GitHubPullRequestOutcomeInput,
  githubPullRequestOutcomeInputSchema,
} from "./store.js";

export const GITHUB_PULL_REQUEST_OUTCOME_TASK = "applyPullRequestOutcome";

const isoDateSchema = z.iso.datetime().transform((value) => new Date(value));

const pullRequestOutcomePayloadSchema =
  githubPullRequestOutcomeInputSchema.extend({
    closedAt: isoDateSchema.optional(),
    mergedAt: isoDateSchema.optional(),
    openedAt: isoDateSchema,
    updatedAt: isoDateSchema,
  });

/** One task per outcome. A later change of the pull request is a new outcome. */
export function githubPullRequestOutcomeTaskKey(
  outcome: GitHubPullRequestOutcomeInput,
): string {
  return `pull-request-outcome:${outcome.pullRequestId}:${outcome.state}:${outcome.updatedAt.toISOString()}`;
}

/** Apply the outcome in the task payload. The outcome row, code index, and Inbox closes all repeat safely. */
export const githubPullRequestOutcomeTask: PluginStartedTaskDefinition<
  typeof pullRequestOutcomePayloadSchema
> = {
  payload: pullRequestOutcomePayloadSchema,
  async run(ctx) {
    await applyGitHubPullRequestOutcome({
      codeChanges: ctx.codeChanges,
      conversationChanges: ctx.conversationChanges,
      db: gitHubDbSchema.parse(ctx.db),
      log: ctx.log,
      outcome: ctx.payload,
    });
  },
};
