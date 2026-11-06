import type { PluginLogger, User } from "@sentry/junior-plugin-api";
import type { GitHubDb } from "../db/database.js";
import {
  linkedGitHubLogin,
  mentionLinkedRequester,
} from "../tool-support/attribution.js";
import {
  updatePullRequestForLinkedRequester,
  type GitHubInstallationEnv,
} from "../webhooks/installation-requests.js";
import { listGitHubPullRequestsRequestedBy } from "./store.js";

const LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_PULL_REQUESTS = 20;

/**
 * Update the recent open pull requests that a person asked Junior for,
 * after they link their GitHub account: assign the ones they asked Junior to
 * open, and mention them in place of their name. Each pull request updates
 * on its own, so one failure leaves the others updated. A repeat changes
 * nothing.
 */
export async function updatePullRequestsForLinkedUser(args: {
  db: GitHubDb;
  env: GitHubInstallationEnv;
  log: PluginLogger;
  nowMs: number;
  user: User;
}): Promise<void> {
  const login = linkedGitHubLogin(args.user);
  if (!login) return;
  const pullRequests = await listGitHubPullRequestsRequestedBy(args.db, {
    identityIds: args.user.identities.map((identity) => identity.id),
    limit: MAX_PULL_REQUESTS,
    since: new Date(args.nowMs - LOOKBACK_MS),
  });
  for (const pullRequest of pullRequests) {
    try {
      await updatePullRequestForLinkedRequester(args.env, {
        assign: pullRequest.opened,
        login,
        mention: (body) => mentionLinkedRequester(body, args.user),
        number: pullRequest.number,
        repositoryFullName: pullRequest.repositoryFullName,
      });
    } catch (error) {
      args.log.warn("github.identity_linked.pull_request_update.failed", {
        "exception.message":
          error instanceof Error ? error.message : String(error),
        number: pullRequest.number,
        repo: pullRequest.repositoryFullName,
      });
    }
  }
}
