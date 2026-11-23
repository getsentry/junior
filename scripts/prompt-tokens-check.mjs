import fs from "node:fs";
import {
  assertPromptTokenStats,
  promptTokensTitle,
  renderPromptTokensReport,
} from "./prompt-tokens.mjs";

/**
 * `actions/github-script` steps of the Prompt Tokens workflow. Each run
 * uploads its stats as `prompt-tokens-<sha>`. A pull request compares with
 * the stats of its base commit, and a push with the stats of the commit
 * before it, when that run uploaded them.
 */

const STATUS_CONTEXT = "prompt tokens";

/** The artifact name of the stats that a run on one commit uploads. */
export function promptTokensArtifactName(sha) {
  return `prompt-tokens-${sha}`;
}

function baseSha(context) {
  return context.payload.pull_request?.base.sha ?? context.payload.before;
}

/**
 * Set the `run-id` and `sha` outputs to the run that uploaded the stats of
 * the base commit. Sets no outputs when there are none, such as when that
 * run has not finished.
 */
export async function findPromptTokensBase({ github, context, core }) {
  const sha = baseSha(context);
  if (!sha) {
    core.info("The event has no base commit.");
    return;
  }
  const { data } = await github.rest.actions.listArtifactsForRepo({
    owner: context.repo.owner,
    repo: context.repo.repo,
    name: promptTokensArtifactName(sha),
  });
  const artifact = data.artifacts.find((item) => !item.expired);
  if (!artifact?.workflow_run?.id) {
    core.info(`No prompt token stats for ${sha}.`);
    return;
  }
  core.setOutput("run-id", String(artifact.workflow_run.id));
  core.setOutput("sha", sha);
}

function readStats(file) {
  return assertPromptTokenStats(JSON.parse(fs.readFileSync(file, "utf8")));
}

/**
 * Publish the total as the `prompt tokens` commit status and the report as
 * the job summary, which the status links to. `basePath` and `baseSha` are
 * empty when there are no base stats.
 *
 * A commit status shows its description in the pull request checks list. A
 * check run that `GITHUB_TOKEN` creates joins an arbitrary Actions check
 * suite, so the list can hide it.
 */
export async function publishPromptTokensStatus({
  github,
  context,
  core,
  statsPath,
  basePath,
  baseSha: baseCommit,
}) {
  const stats = readStats(statsPath);
  const base = basePath ? readStats(basePath) : undefined;
  const shortSha = baseCommit.slice(0, 7);
  const report = renderPromptTokensReport(stats, base, `\`${shortSha}\``);
  await core.summary.addRaw(report).write();
  await github.rest.repos.createCommitStatus({
    owner: context.repo.owner,
    repo: context.repo.repo,
    // A pull request run measures a merge commit. Its status goes on the head.
    sha: context.payload.pull_request?.head.sha ?? context.sha,
    state: "success",
    context: STATUS_CONTEXT,
    description: promptTokensTitle(stats, base, shortSha),
    target_url: `${context.serverUrl}/${context.repo.owner}/${context.repo.repo}/actions/runs/${context.runId}`,
  });
}
