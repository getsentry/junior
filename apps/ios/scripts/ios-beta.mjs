/**
 * `actions/github-script` steps that start an iOS beta from a pull request
 * label and keep its status in the pull request description.
 *
 * The `trigger-ios-beta` label runs `.github/workflows/ios-beta-label.yml`.
 * It removes the label, so adding it again starts another beta, and
 * dispatches `.github/workflows/ios-beta.yml` on the pull request's branch.
 * That run reports when it starts and when it ends.
 */

const BETA_LABEL = "trigger-ios-beta";
const WORKFLOW = "ios-beta.yml";
const START = "<!-- ios-beta:start -->";
const END = "<!-- ios-beta:end -->";

/**
 * Return `body` with its iOS beta status block set to `line`. The block goes
 * at the end the first time.
 */
export function withBetaStatus(body, line) {
  const block = `${START}\n${line}\n${END}`;
  const text = body ?? "";
  const start = text.indexOf(START);
  const end = text.indexOf(END, start);
  if (start === -1 || end === -1) return text ? `${text}\n\n${block}` : block;
  return text.slice(0, start) + block + text.slice(end + END.length);
}

/** The status line for one state of a beta. */
export function betaStatusLine({ state, sha, build, runUrl }) {
  const commit = sha ? `\`${sha.slice(0, 7)}\`` : "";
  const run = `[run](${runUrl})`;
  switch (state) {
    case "queued":
      return `**iOS beta:** queued · [runs](${runUrl})`;
    case "outdated":
      return "**iOS beta:** not started. This branch's `ios-beta.yml` is older than the label: merge `main`, then add the label again.";
    case "building":
      return `**iOS beta:** building ${commit} · ${run}`;
    case "success":
      return `**iOS beta:** build ${build} of ${commit} uploaded to TestFlight · ${run}`;
    case "cancelled":
      return `**iOS beta:** cancelled for ${commit} · ${run}`;
    default:
      return `**iOS beta:** failed for ${commit} · ${run}`;
  }
}

async function setBetaStatus({ github, context, pullNumber, line }) {
  const { owner, repo } = context.repo;
  const { data } = await github.rest.pulls.get({
    owner,
    repo,
    pull_number: pullNumber,
  });
  await github.rest.pulls.update({
    owner,
    repo,
    pull_number: pullNumber,
    body: withBetaStatus(data.body, line),
  });
}

/**
 * On the `trigger-ios-beta` label: remove it, dispatch the beta on the pull
 * request's branch, and show the beta as queued.
 */
export async function dispatchBeta({ github, context, core }) {
  const { owner, repo } = context.repo;
  const pullRequest = context.payload.pull_request;
  try {
    await github.rest.issues.removeLabel({
      owner,
      repo,
      issue_number: pullRequest.number,
      name: BETA_LABEL,
    });
  } catch (error) {
    // Someone removed it already.
    if (error.status !== 404) throw error;
  }
  const runUrl = `${context.serverUrl}/${owner}/${repo}/actions/workflows/${WORKFLOW}`;
  try {
    await github.rest.actions.createWorkflowDispatch({
      owner,
      repo,
      workflow_id: WORKFLOW,
      ref: pullRequest.head.ref,
      inputs: { pull_request: String(pullRequest.number) },
    });
  } catch (error) {
    // GitHub answers 422 "Unexpected inputs provided".
    if (error.status !== 422 || !/unexpected inputs/i.test(error.message))
      throw error;
    // The dispatch runs the branch's own ios-beta.yml. A branch from before
    // the `pull_request` input has an older one, which rejects the input.
    await setBetaStatus({
      github,
      context,
      pullNumber: pullRequest.number,
      line: betaStatusLine({ state: "outdated", runUrl }),
    });
    throw error;
  }
  core.info(`Dispatched ${WORKFLOW} on ${pullRequest.head.ref}.`);
  await setBetaStatus({
    github,
    context,
    pullNumber: pullRequest.number,
    line: betaStatusLine({ state: "queued", runUrl }),
  });
}

/**
 * From the beta run: write its state to the pull request description.
 * `state` is `building`, or the result of the TestFlight job.
 */
export async function reportBeta({
  github,
  context,
  pullRequest,
  state,
  build,
}) {
  if (!/^\d+$/.test(pullRequest))
    throw new Error(`Not a pull request number: ${pullRequest}`);
  const { owner, repo } = context.repo;
  await setBetaStatus({
    github,
    context,
    pullNumber: Number(pullRequest),
    line: betaStatusLine({
      state,
      sha: context.sha,
      build,
      runUrl: `${context.serverUrl}/${owner}/${repo}/actions/runs/${context.runId}`,
    }),
  });
}
