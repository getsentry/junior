/**
 * Git push policy for GitHub smart HTTP.
 *
 * Junior pushes with the App installation token, so a push lands as the App
 * no matter who asked. Junior proposes changes through pull requests. It
 * never updates or deletes the repository's default branch, and it pushes
 * only branches. It never moves an existing branch to a commit that GitHub
 * already has, because that can close the branch's pull request. Other
 * protected branches rely on GitHub rulesets.
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
import type { GitHubInstallationEnv } from "./webhooks/installation-requests.js";

const DENIAL_NOTE =
  "This is a runtime policy denial, not a GitHub permission failure.";
const NEW_BRANCH_GUIDANCE =
  "Push to a new branch and open a pull request with github_createPullRequest.";
const EXISTING_COMMIT_GUIDANCE =
  "Check that the local branch has the intended commits before you push again. To undo a commit, push a new revert commit.";

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
 * `refs/heads/`, or moves an existing branch to a commit that GitHub already
 * has. Returns the audit attributes for an allowed push.
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
  // An existing branch moved to a commit that GitHub already has, such as
  // old main, can be left with no commits ahead of a pull request's base.
  // GitHub then closes the pull request. The pack shows this without a
  // GitHub request: Git sends no objects that the remote already has.
  const movedToExisting =
    input.gitPush.packObjectCount === 0
      ? updates.filter((update) => !update.creates && !update.deletes)
      : [];
  if (movedToExisting.length > 0) {
    const branches = movedToExisting.map((update) =>
      update.ref.slice("refs/heads/".length),
    );
    deny(
      `The runtime refused to move ${branches.join(", ")} to a commit that GitHub already has, such as an older commit or another branch's commit. If the branch has an open pull request, GitHub would close it when the branch has no commits ahead of its base.`,
      {
        auditAttributes: {
          ...attributes,
          "app.github.moved_to_existing_commit": true,
        },
        guidance: EXISTING_COMMIT_GUIDANCE,
      },
    );
  }
  return attributes;
}
