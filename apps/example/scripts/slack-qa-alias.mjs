import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// This operator script selects a preview, not a lock. Checks detect alias changes
// at a point in time. They cannot prevent another operator from changing it.

/** Reject deployments that do not match the requested example preview. */
export function assertQaDeployment(
  deployment,
  { projectId, deploymentId, sha },
) {
  if (
    deployment.id !== deploymentId ||
    deployment.projectId !== projectId ||
    deployment.name !== "junior-example" ||
    deployment.readyState !== "READY" ||
    (deployment.target !== null && deployment.target !== "preview") ||
    deployment.meta?.githubCommitOrg !== "getsentry" ||
    deployment.meta?.githubCommitRepo !== "junior" ||
    deployment.meta?.githubCommitSha !== sha
  ) {
    throw new Error(
      "Expected a ready junior-example preview of the requested getsentry/junior commit.",
    );
  }
}

/** Fail the QA check if another deployment now owns the alias. */
export function assertQaAlias(alias, deploymentId) {
  if (alias.deploymentId !== deploymentId || alias.redirect) {
    throw new Error(
      `QA alias changed: expected ${deploymentId}, found ${alias.deploymentId ?? "none"}. Stop testing; do not restore or delete the alias.`,
    );
  }
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

async function main() {
  const [action, deploymentId, sha, ...extra] = process.argv.slice(2);
  if (
    !["select", "check"].includes(action) ||
    !/^dpl_[a-zA-Z0-9]+$/.test(deploymentId ?? "") ||
    !/^[a-f0-9]{40}$/.test(sha ?? "") ||
    extra.length
  ) {
    throw new Error(
      "Usage: node apps/example/scripts/slack-qa-alias.mjs <select|check> <deployment-id> <full-commit-sha>",
    );
  }
  const token = required("SLACK_QA_VERCEL_TOKEN");
  const projectId = required("SLACK_QA_PROJECT_ID");
  const teamId = required("SLACK_QA_TEAM_ID");
  const hostname = required("SLACK_QA_ALIAS");
  // Keep the mutation away from the existing production and branch aliases.
  if (!/^junior-slack-qa(?:-[a-z0-9]+)?\.sentry\.dev$/.test(hostname)) {
    throw new Error(
      "SLACK_QA_ALIAS must be a dedicated junior-slack-qa[-name].sentry.dev hostname.",
    );
  }

  async function request(path, body) {
    const url = new URL(path, "https://api.vercel.com");
    url.searchParams.set("teamId", teamId);
    const response = await fetch(url, {
      method: body ? "POST" : "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      // Do not print provider payloads: deployment responses can contain secrets.
      throw new Error(
        `Vercel ${body ? "POST" : "GET"} ${url.pathname}: HTTP ${response.status}`,
      );
    }
    return response.json();
  }

  const deployment = await request(`/v13/deployments/${deploymentId}`);
  assertQaDeployment(deployment, { projectId, deploymentId, sha });
  if (action === "select") {
    await request(`/v2/deployments/${deploymentId}/aliases`, {
      alias: hostname,
    });
  }
  const alias = await request(`/v4/aliases/${hostname}`);
  assertQaAlias(alias, deploymentId);
  const summary = [
    `QA alias ${action}: https://${hostname}`,
    `Deployment: ${deploymentId}`,
    `Commit: ${sha}`,
    `Checked at: ${new Date().toISOString()}`,
    "This is a point-in-time check, not a lock or a Slack test result.",
  ].join("\n");
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
