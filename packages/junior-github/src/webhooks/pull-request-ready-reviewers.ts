/**
 * The review request for a Junior draft pull request when it becomes ready.
 *
 * Junior asks for no review while a pull request is a draft. When GitHub
 * marks the draft ready for review, Junior asks the reviewers that the person
 * named, or else the requester's linked GitHub account.
 */
import type { PluginLogger, PluginState } from "@sentry/junior-plugin-api";
import * as z from "zod";
import type { GitHubDb } from "../db/database.js";
import { readGitHubDraftReviewers } from "../pull-request-requesters/draft-reviewers.js";
import { listGitHubPullRequestOpeners } from "../pull-request-requesters/store.js";
import {
  requestPullRequestReviewers,
  type GitHubInstallationEnv,
} from "./installation-requests.js";

const readyForReviewSchema = z.object({
  action: z.literal("ready_for_review"),
  pull_request: z.object({ number: z.number().int().positive() }),
  repository: z.object({ full_name: z.string().min(1) }),
});

/**
 * Ask for the review of a Junior pull request that GitHub marked ready for
 * review. The request is optional, so a failure is logged and does not fail
 * the delivery.
 */
export async function requestGitHubReviewersWhenReady(args: {
  body: unknown;
  db: GitHubDb;
  deliveryId: string;
  env: GitHubInstallationEnv;
  eventName: string;
  loadGitHubLogin?(identityId: string): Promise<string | undefined>;
  log?: Pick<PluginLogger, "warn">;
  state: PluginState;
}): Promise<void> {
  if (args.eventName !== "pull_request") return;
  const parsed = readyForReviewSchema.safeParse(args.body);
  if (!parsed.success) return;
  const target = {
    number: parsed.data.pull_request.number,
    repositoryFullName: parsed.data.repository.full_name,
  };
  try {
    const opener = (
      await listGitHubPullRequestOpeners(args.db, {
        numbers: [target.number],
        repositoryFullName: target.repositoryFullName,
      })
    ).get(target.number);
    // Only a pull request that a person asked Junior to open has a requester.
    if (!opener) return;
    const named = await readGitHubDraftReviewers(args.state, target);
    const requester = named
      ? undefined
      : await args.loadGitHubLogin?.(opener.identityId);
    const reviewers = named ?? (requester ? [requester] : []);
    if (reviewers.length === 0) return;
    await requestPullRequestReviewers(args.env, { ...target, reviewers });
  } catch (error) {
    args.log?.warn("GitHub pull request review request failed", {
      deliveryId: args.deliveryId,
      errorType: error instanceof Error ? error.name : "UnknownError",
      number: target.number,
      repository: target.repositoryFullName,
    });
  }
}
