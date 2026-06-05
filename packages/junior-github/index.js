import { defineJuniorPlugin } from "@sentry/junior-plugin-api";

function readEnv(name) {
  const value = process.env[name];
  return typeof value === "string" && value ? value : undefined;
}

function cleanIdentityPart(value) {
  return String(value ?? "")
    .replaceAll("\n", " ")
    .replaceAll("\r", " ")
    .replace(/[<>]/g, "")
    .trim();
}

function isSlackUserId(value) {
  return /^[UW][A-Z0-9]{5,}$/.test(value);
}

function requesterDisplayName(value, requester) {
  const name = cleanIdentityPart(value);
  if (
    !name ||
    name.toLowerCase() === "unknown" ||
    name === cleanIdentityPart(requester?.userId)
  ) {
    return undefined;
  }
  return isSlackUserId(name) ? undefined : name;
}

function requesterName(requester) {
  return (
    requesterDisplayName(requester?.fullName, requester) ||
    requesterDisplayName(requester?.userName, requester) ||
    undefined
  );
}

function requesterEmail(requester) {
  const email = cleanIdentityPart(requester?.email);
  return /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email) ? email : undefined;
}

function isGitCommitCommand(command) {
  return /(?:^|[\s;|&])git(?:\s+(?:-C\s+\S+|-c\s+\S+|--git-dir(?:=\S+|\s+\S+)|--work-tree(?:=\S+|\s+\S+)|--namespace(?:=\S+|\s+\S+)))*\s+commit(?:\s|$)/.test(
    command,
  );
}

function prepareCommitMsgHook() {
  return `#!/usr/bin/env bash
set -eu

message_file="\${1:-}"
if [ -z "$message_file" ]; then
  exit 1
fi

if [ -z "\${JUNIOR_GIT_AUTHOR_NAME:-}" ] || [ -z "\${JUNIOR_GIT_AUTHOR_EMAIL:-}" ]; then
  echo "Junior GitHub plugin internal error: bot commit attribution was not injected by the host runtime. Do not set Git author env vars manually; report this configuration error." >&2
  exit 1
fi

if [ "\${GIT_AUTHOR_NAME:-}" != "$JUNIOR_GIT_AUTHOR_NAME" ] || [ "\${GIT_AUTHOR_EMAIL:-}" != "$JUNIOR_GIT_AUTHOR_EMAIL" ]; then
  echo "Junior GitHub plugin internal error: Git author was not set to the configured bot identity. Do not override Git author manually; report this configuration error." >&2
  exit 1
fi

if [ -z "\${JUNIOR_GIT_COAUTHOR_NAME:-}" ] || [ -z "\${JUNIOR_GIT_COAUTHOR_EMAIL:-}" ]; then
  echo "Junior GitHub plugin internal error: requester coauthor identity was not injected by the host runtime. Do not set coauthor env vars manually; report this configuration error." >&2
  exit 1
fi

trailer="Co-authored-by: $JUNIOR_GIT_COAUTHOR_NAME <$JUNIOR_GIT_COAUTHOR_EMAIL>"
if grep -Fqx "$trailer" "$message_file"; then
  exit 0
fi

printf '\\n%s\\n' "$trailer" >> "$message_file"
`;
}

async function configureGit(ctx, key, value) {
  const result = await ctx.sandbox.run({
    cmd: "git",
    args: ["config", "--global", key, value],
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to configure git ${key}: ${result.stderr || result.stdout}`,
    );
  }
}

/** Register trusted GitHub runtime hooks for commit attribution and package loading. */
export function githubPlugin(options = {}) {
  const botNameEnv = options.botNameEnv ?? "GITHUB_APP_BOT_NAME";
  const botEmailEnv = options.botEmailEnv ?? "GITHUB_APP_BOT_EMAIL";

  return defineJuniorPlugin({
    packageName: "@sentry/junior-github",
    manifest: {
      name: "github",
      description:
        "GitHub issue, pull request, and repository workflows via GitHub App",
      configKeys: ["org", "repo"],
      envVars: {
        GITHUB_APP_BOT_NAME: { exposeToCommandEnv: true },
        GITHUB_APP_BOT_EMAIL: { exposeToCommandEnv: true },
      },
      credentials: {
        type: "github-app",
        domains: ["api.github.com", "github.com"],
        authTokenEnv: "GITHUB_TOKEN",
        authTokenPlaceholder: "ghp_host_managed_credential",
        appIdEnv: "GITHUB_APP_ID",
        privateKeyEnv: "GITHUB_APP_PRIVATE_KEY",
        installationIdEnv: "GITHUB_INSTALLATION_ID",
      },
      commandEnv: {
        GIT_AUTHOR_NAME: "${GITHUB_APP_BOT_NAME}",
        GIT_AUTHOR_EMAIL: "${GITHUB_APP_BOT_EMAIL}",
        GIT_COMMITTER_NAME: "${GITHUB_APP_BOT_NAME}",
        GIT_COMMITTER_EMAIL: "${GITHUB_APP_BOT_EMAIL}",
      },
      target: {
        type: "repo",
        configKey: "repo",
        commandFlags: ["--repo", "-R"],
      },
      runtimeDependencies: [
        {
          type: "system",
          package: "gh",
        },
      ],
    },
    hooks: {
      async sandboxPrepare(ctx) {
        const hooksPath = `${ctx.sandbox.juniorRoot}/git-hooks`;
        await ctx.sandbox.writeFile({
          path: `${hooksPath}/prepare-commit-msg`,
          mode: 0o755,
          content: prepareCommitMsgHook(),
        });
        await configureGit(ctx, "core.hooksPath", hooksPath);
        await configureGit(ctx, "commit.gpgsign", "false");
        await configureGit(ctx, "credential.helper", "");
        await configureGit(ctx, "http.emptyAuth", "true");
      },
      beforeToolExecute(ctx) {
        if (ctx.tool.name !== "bash") {
          return;
        }
        const command =
          typeof ctx.tool.input === "object" &&
          ctx.tool.input &&
          "command" in ctx.tool.input
            ? String(ctx.tool.input.command ?? "")
            : "";
        const botName = readEnv(botNameEnv);
        const botEmail = readEnv(botEmailEnv);
        if ((!botName || !botEmail) && isGitCommitCommand(command)) {
          ctx.decision.deny(
            `Junior GitHub plugin is misconfigured: host env vars ${botNameEnv} and ${botEmailEnv} are missing. This is an internal deployment configuration error; do not set them in the sandbox.`,
          );
          return;
        }
        if (!botName || !botEmail) {
          return;
        }
        const coauthorName = requesterName(ctx.requester);
        const coauthorEmail = requesterEmail(ctx.requester);
        if ((!coauthorName || !coauthorEmail) && isGitCommitCommand(command)) {
          ctx.decision.deny(
            "Junior GitHub plugin could not determine a resolved requester name and email for commit attribution. This is an internal request-context error; do not set coauthor env vars manually.",
          );
          return;
        }
        ctx.env.set("GIT_AUTHOR_NAME", botName);
        ctx.env.set("GIT_AUTHOR_EMAIL", botEmail);
        ctx.env.set("GIT_COMMITTER_NAME", botName);
        ctx.env.set("GIT_COMMITTER_EMAIL", botEmail);
        ctx.env.set("JUNIOR_GIT_AUTHOR_NAME", botName);
        ctx.env.set("JUNIOR_GIT_AUTHOR_EMAIL", botEmail);
        if (coauthorName && coauthorEmail) {
          ctx.env.set("JUNIOR_GIT_COAUTHOR_NAME", coauthorName);
          ctx.env.set("JUNIOR_GIT_COAUTHOR_EMAIL", coauthorEmail);
        }
      },
    },
  });
}
