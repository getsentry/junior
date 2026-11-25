/**
 * `actions/github-script` step of the dashboard screenshots job. A pull
 * request run builds the merge commit, so its screenshots show the merge
 * commit's first parent: the `main` that was built. `pull_request.base.sha`
 * can be older than that `main`, and then the changes on `main` since it show
 * as changes of the pull request.
 */

/** The artifact name of the screenshots that Frameshift saves for a commit. */
export function frameshiftBaselineArtifactName(sha) {
  return `frameshift-baseline-v1-${sha}`;
}

/**
 * Set `sha` to the first parent of the merge commit that the run built, and
 * `found` to whether Frameshift saved screenshots for that commit. The first
 * default-branch run on a commit saves them.
 */
export async function findFrameshiftBaseline({ github, context, core }) {
  const { owner, repo } = context.repo;
  const { data: commit } = await github.rest.git.getCommit({
    owner,
    repo,
    commit_sha: context.sha,
  });
  const sha = commit.parents[0]?.sha;
  if (!sha) {
    throw new Error(`Commit ${context.sha} has no parent.`);
  }
  const { data } = await github.rest.actions.listArtifactsForRepo({
    owner,
    repo,
    name: frameshiftBaselineArtifactName(sha),
  });
  const found = data.artifacts.some((artifact) => !artifact.expired);
  core.setOutput("sha", sha);
  core.setOutput("found", String(found));
  if (!found) {
    core.info(
      `No baseline exists for ${sha}. The first default-branch run will create it.`,
    );
  }
}
