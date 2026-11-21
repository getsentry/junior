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

const CHECK_NAME = "prompt tokens";

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
 * Publish the report as the `prompt tokens` check run on the measured
 * commit and as the job summary. `basePath` and `baseSha` are empty when
 * there are no base stats.
 */
export async function publishPromptTokensCheck({
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
  await github.rest.checks.create({
    owner: context.repo.owner,
    repo: context.repo.repo,
    name: CHECK_NAME,
    // A pull request run measures a merge commit. Its check goes on the head.
    head_sha: context.payload.pull_request?.head.sha ?? context.sha,
    status: "completed",
    conclusion: "success",
    details_url: `${context.serverUrl}/${context.repo.owner}/${context.repo.repo}/actions/runs/${context.runId}`,
    output: {
      title: promptTokensTitle(stats, base, shortSha),
      summary: report,
    },
  });
  await core.summary.addRaw(report).write();
}
