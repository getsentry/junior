/**
 * GitHub writes that a dismiss of a GitHub Inbox item makes with
 * installation tokens, to take the person off the object on GitHub.
 */
import * as z from "zod";
import {
  GitHubRequestError,
  githubRequest,
  issueInstallationToken,
} from "../credential-support.js";
import {
  splitRepository,
  type GitHubInstallationEnv,
} from "./installation-requests.js";

/**
 * Unassign people from one issue, with an issues write token. A gone issue
 * has nobody left to unassign.
 */
export async function removeIssueAssignees(
  env: GitHubInstallationEnv,
  input: { assignees: string[]; number: number; repositoryFullName: string },
): Promise<void> {
  const { owner, name } = splitRepository(
    input.repositoryFullName,
    "issue unassign",
  );
  const token = await issueInstallationToken({
    ...env,
    permissions: { issues: "write" },
    repositories: [name],
  });
  try {
    await githubRequest(
      "https://api.github.com",
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues/${input.number}/assignees`,
      {
        body: { assignees: input.assignees },
        method: "DELETE",
        token: token.token,
      },
    );
  } catch (error) {
    // GitHub answers 410 for a deleted issue, and 404 when the issue or its
    // repository is out of reach.
    if (
      error instanceof GitHubRequestError &&
      (error.status === 404 || error.status === 410)
    ) {
      return;
    }
    throw error;
  }
}

// Only user reviewers: a team request names no person.
const requestedReviewersSchema = z.object({
  requested_reviewers: z.array(z.object({ login: z.string().min(1) })),
});

/**
 * Remove one person from the requested reviewers of a pull request, with a
 * pull requests write token. Does nothing when GitHub does not list them
 * or the pull request is gone.
 */
export async function removeRequestedReviewer(
  env: GitHubInstallationEnv,
  input: { login: string; number: number; repositoryFullName: string },
): Promise<void> {
  const { owner, name } = splitRepository(
    input.repositoryFullName,
    "review request removal",
  );
  const token = await issueInstallationToken({
    ...env,
    permissions: { pull_requests: "write" },
    repositories: [name],
  });
  const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls/${input.number}`;
  try {
    const pullRequest = requestedReviewersSchema.parse(
      await githubRequest("https://api.github.com", path, {
        token: token.token,
      }),
    );
    const login = input.login.toLowerCase();
    if (
      !pullRequest.requested_reviewers.some(
        (reviewer) => reviewer.login.toLowerCase() === login,
      )
    ) {
      return;
    }
    await githubRequest(
      "https://api.github.com",
      `${path}/requested_reviewers`,
      {
        body: { reviewers: [input.login] },
        method: "DELETE",
        token: token.token,
      },
    );
  } catch (error) {
    // A gone pull request has nobody left to remove.
    if (
      error instanceof GitHubRequestError &&
      (error.status === 404 || error.status === 410)
    ) {
      return;
    }
    throw error;
  }
}
