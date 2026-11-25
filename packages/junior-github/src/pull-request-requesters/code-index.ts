import type { PluginCodeChanges } from "@sentry/junior-plugin-api";
import type { GitHubDb } from "../db/database.js";
import { listGitHubPullRequestRequesters } from "./store.js";

/**
 * Credit the saved requesters of some pull requests in one repository on
 * their code changes, so Code · Mine lists each for every person it credits.
 *
 * Call it after a requester row is saved and after a code change is
 * recorded. A pull request that the code index does not have yet is skipped,
 * and the write that records it calls this again. Because each side writes
 * before it reads the other, the requester reaches the code change whichever
 * of them comes first.
 */
export async function syncGitHubPullRequestRequesters(args: {
  codeChanges: Pick<PluginCodeChanges, "associateRequesters" | "list">;
  db: GitHubDb;
  numbers: number[];
  repositoryFullName: string;
}): Promise<void> {
  const requesters = await listGitHubPullRequestRequesters(args.db, args);
  if (requesters.size === 0) return;
  const changes = await args.codeChanges.list({
    repository: {
      name: args.repositoryFullName,
      numbers: [...requesters.keys()],
    },
  });
  for (const change of changes) {
    const identityIds = requesters.get(change.number);
    if (!identityIds) continue;
    // oxlint-disable-next-line no-await-in-loop -- One small write per pull request, in order.
    await args.codeChanges.associateRequesters({
      identityIds,
      providerId: change.providerId,
    });
  }
}
