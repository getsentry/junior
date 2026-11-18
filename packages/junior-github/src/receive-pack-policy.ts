/**
 * Git push policy for GitHub smart HTTP.
 *
 * Junior pushes with the App installation token, so a push lands as the App
 * no matter who asked. Junior proposes changes through pull requests. It
 * never updates or deletes the repository's default branch, and it pushes
 * only branches. Other protected branches rely on GitHub rulesets.
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

const DENIAL_SUFFIX =
  "This is a runtime policy denial, not a GitHub permission failure. Push to a new branch and open a pull request with github_createPullRequest.";

const UNREADABLE_MESSAGES: Record<PluginGitPushUnreadableReason, string> = {
  gzip: "The runtime cannot read a gzip-compressed Git push.",
  malformed: "The runtime could not read the Git push command list.",
  signed: "The runtime does not accept signed Git pushes.",
  unterminated:
    "The runtime could not find the end of the Git push command list.",
};

function deny(
  message: string,
  options?: { auditAttributes?: PluginAuditAttributes; cause?: unknown },
): never {
  throw new EgressPolicyDenied(`${message} ${DENIAL_SUFFIX}`, options);
}

/**
 * Refuse a Git push that changes the default branch or a ref outside
 * `refs/heads/`. Returns the audit attributes for an allowed push.
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
  return attributes;
}
