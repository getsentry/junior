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

const storedDateSchema = z.iso.datetime().transform((value) => new Date(value));

const pullRequestOutcomePayloadSchema =
  githubPullRequestOutcomeInputSchema.extend({
    closedAt: storedDateSchema.optional(),
    mergedAt: storedDateSchema.optional(),
    openedAt: storedDateSchema,
    updatedAt: storedDateSchema,
  });

/** One task per outcome. A later change of the pull request is a new outcome. */
export function githubPullRequestOutcomeTaskKey(
  outcome: GitHubPullRequestOutcomeInput,
): string {
  return `pull-request-outcome:${outcome.pullRequestId}:${outcome.state}:${outcome.updatedAt.toISOString()}`;
}

/** Apply a stored outcome. The stored row, code index, chips, and Inbox closes all repeat safely. */
export const githubPullRequestOutcomeTask: PluginStartedTaskDefinition<
  typeof pullRequestOutcomePayloadSchema
> = {
  payload: pullRequestOutcomePayloadSchema,
  async run(ctx) {
    await applyGitHubPullRequestOutcome({
      annotations: ctx.annotations,
      codeChanges: ctx.codeChanges,
      conversationChanges: ctx.conversationChanges,
      db: gitHubDbSchema.parse(ctx.db),
      log: ctx.log,
      outcome: ctx.payload,
    });
  },
};
