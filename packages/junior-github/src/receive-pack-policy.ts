/**
 * Git push policy for GitHub smart HTTP.
 *
 * Junior pushes with the App installation token, so a push lands as the App
 * no matter who asked. Junior proposes changes through pull requests. It
 * never updates or deletes the repository's default branch, and it pushes
 * only branches. It also refuses a push that would leave an open pull request
 * with no commits ahead of its base, because GitHub then closes the pull
 * request at once. Other protected branches rely on GitHub rulesets.
 */
import {
  EgressPolicyDenied,
  type PluginAuditAttributes,
  type PluginCache,
  type PluginGitPush,
  type PluginGitPushUnreadableReason,
} from "@sentry/junior-plugin-api";
import type { GitHubRepository } from "./credential-support.js";
import { loadDefaultBranch } from "./default-branch.js";
import {
  findEmptiedPullRequests,
  type EmptiedPullRequest,
} from "./open-pull-request-heads.js";
import type { GitHubInstallationEnv } from "./webhooks/installation-requests.js";

const DENIAL_NOTE =
  "This is a runtime policy denial, not a GitHub permission failure.";
const NEW_BRANCH_GUIDANCE =
  "Push to a new branch and open a pull request with github_createPullRequest.";
const EMPTIED_PULL_REQUEST_GUIDANCE =
  "Check that the local branch has the pull request's commits on top of its base before you push again.";

const UNREADABLE_MESSAGES: Record<PluginGitPushUnreadableReason, string> = {
  gzip: "The runtime cannot read a gzip-compressed Git push.",
  malformed: "The runtime could not read the Git push command list.",
  signed: "The runtime does not accept signed Git pushes.",
  unterminated:
    "The runtime could not find the end of the Git push command list.",
};

function deny(
  message: string,
  options?: {
    auditAttributes?: PluginAuditAttributes;
    cause?: unknown;
    guidance?: string;
  },
): never {
  const { guidance = NEW_BRANCH_GUIDANCE, ...rest } = options ?? {};
  throw new EgressPolicyDenied(`${message} ${DENIAL_NOTE} ${guidance}`, rest);
}

/**
 * Refuse a Git push that changes the default branch, changes a ref outside
 * `refs/heads/`, or leaves an open pull request with no commits ahead of its
 * base. Returns the audit attributes for an allowed push.
 */
export async function assertGitHubPushAllowed(input: {
  cache: PluginCache;
  env: GitHubInstallationEnv;
  gitPush: PluginGitPush | undefined;
  repository: GitHubRepository;
}): Promise<PluginAuditAttributes> {
  if (!input.gitPush) {
    deny(UNREADABLE_MESSAGES.malformed);
  }
  if (input.gitPush.kind === "unreadable") {
    deny(UNREADABLE_MESSAGES[input.gitPush.reason]);
  }
  const { updates } = input.gitPush;
  const refs = updates.map((update) => update.ref);
  const outsideBranches = refs.filter((ref) => !ref.startsWith("refs/heads/"));
  if (outsideBranches.length > 0) {
    deny(
      `The runtime pushes only branches. It refused ${outsideBranches.join(", ")}.`,
      { auditAttributes: { "app.github.refs": refs } },
    );
  }
  if (updates.length === 0) {
    // Git sends a lone flush packet to probe auth before a large push.
    return { "app.github.refs": refs };
  }
  let defaultBranch: string;
  try {
    defaultBranch = await loadDefaultBranch(
      input.env,
      input.cache,
      input.repository,
    );
  } catch (error) {
    deny(
      `The runtime could not read the default branch of ${input.repository.owner}/${input.repository.name}, so it refused the push.`,
      { auditAttributes: { "app.github.refs": refs }, cause: error },
    );
  }
  const defaultRef = `refs/heads/${defaultBranch}`.toLowerCase();
  const defaultUpdate = updates.find(
    (update) => update.ref.toLowerCase() === defaultRef,
  );
  const attributes = {
    "app.github.default_branch": defaultBranch,
    "app.github.default_branch_targeted": defaultUpdate !== undefined,
    "app.github.refs": refs,
  };
  if (defaultUpdate) {
    deny(
      `The runtime never ${defaultUpdate.deletes ? "deletes" : "pushes to"} the default branch (${defaultBranch}) of ${input.repository.owner}/${input.repository.name}.`,
      { auditAttributes: attributes },
    );
  }
  const repositoryName = `${input.repository.owner}/${input.repository.name}`;
  let emptied: EmptiedPullRequest[];
  try {
    emptied = await findEmptiedPullRequests(
      input.env,
      input.repository,
      updates,
    );
  } catch (error) {
    deny(
      `The runtime could not read the open pull requests of ${repositoryName} for the pushed branches, so it refused the push.`,
      { auditAttributes: attributes, cause: error },
    );
  }
  if (emptied.length > 0) {
    const pulls = emptied.map(
      (pull) =>
        `${repositoryName}#${pull.number} (branch ${pull.branch}, base ${pull.base})`,
    );
    deny(
      `The runtime refused the push because GitHub would close ${pulls.join(", ")}: the branch would have no commits ahead of its base.`,
      {
        auditAttributes: {
          ...attributes,
          "app.github.emptied_pull_requests": emptied.map((pull) =>
            String(pull.number),
          ),
        },
        guidance: EMPTIED_PULL_REQUEST_GUIDANCE,
      },
    );
  }
  return attributes;
}
