---
name: vercel
description: Inspect Vercel deployments and logs through the read-only CLI, or use configured Preview tools to deploy an exact commit, select a QA alias, check its target, or delete a Preview. Use for Vercel investigations and Preview QA setup. Do not use for Production deploys, rollbacks, arbitrary domains, environment changes, caches, or storage.
---

# Vercel Operations

Use the CLI for read-only investigation. Use only the opt-in Preview tools for writes.

## Read-only command allowlist

Run only these Vercel CLI commands:

- `vercel logs`
- `vercel inspect`
- `vercel list` or `vercel ls`
- `vercel help`, `vercel --help`, or `vercel <command> --help`

Do not run `deploy`, `rollback`, `promote`, `remove`, `env`, `alias`, `dns`, `project`, `cache`, `blob`, `certs`, `teams`, `domains`, `git`, `link`, `login`, `logout`, `switch`, `pull`, `build`, `dev`, `redeploy`, `bisect`, `api`, or any command that creates, updates, deletes, purges, promotes, deploys, links, authenticates, or changes Vercel state.

## Preview actions

- Discover `vercel_preview_create`, `vercel_preview_select`, `vercel_preview_inspect`, and `vercel_preview_delete` in the tool catalog. If absent, report that Preview actions are not configured. Do not fall back to CLI writes or ask for tokens in chat.
- The host fixes the team, project, GitHub repository, and QA alias. Conversation defaults cannot expand this scope.
- Deploy only a trusted full commit SHA after the operator confirms isolated Preview state. Builds inherit Preview credentials and can run migrations. This tool does not provision Neon, Redis, or Slack.
- Use `preview_create` once. Save its deployment ID and commit. Inspect before retrying an uncertain create; a timeout can occur after Vercel accepted it.
- Use `preview_select` only when the deployment is READY and the user wants the QA alias moved. It can replace another tester's selection. It does not stop old workers.
- Use `preview_inspect` before and after each QA group. If `aliasMatches` is false, stop and mark the results inconclusive. Do not reassign the alias as automatic recovery. Checks are not a lock and cannot detect every change between requests.
- Delete only the exact Preview the user explicitly requests. Deletion does not clean up its database or Redis state. Do not automatically delete or restore aliases.
- Report deployment and commit IDs. Do not claim Slack QA passed from an alias or health check alone.

## Workflow

1. Resolve the target:

- Determine whether the user needs runtime logs, build logs, deployment status, or deployment discovery.
- Prefer explicit deployment IDs, deployment URLs, project names, environments, branch names, commit SHAs, status filters, and time windows from the user.
- When the user did not specify a project or team, read `vercel.project` and `vercel.team` with `jr-rpc config get` and treat them as optional conversation defaults. Explicit user input always wins.
- Only set or change `vercel.project` and `vercel.team` when the user explicitly asks to store a default for this conversation or channel.
- Ask one concise follow-up only when the request cannot be bounded to a project, deployment, commit, or time window from the thread or config.

2. Run the narrowest safe command:

- The runtime provides Vercel authentication. Do not set, print, echo, write, or ask for `JUNIOR_VERCEL_TOKEN` or `VERCEL_TOKEN`.
- If a command shape or flag is unclear, inspect `vercel <command> --help` before guessing.
- Add `--scope <team>` when a team is known.
- Add `--project <project>` when a project is known and the command supports it.
- For runtime logs, prefer `vercel logs --project <project> --since <window> --limit 20 --json` plus user-provided filters such as `--environment`, `--level`, `--status-code`, `--source`, `--query`, or `--deployment`.
- Use `vercel inspect <deployment-id-or-url> --logs` for build logs. Add `--wait` only when the user explicitly wants to wait for an active build; also bound it with `--timeout`.
- Use `vercel list <project>` or `vercel ls <project>` to find deployments. Prefer filters such as `--status`, `--environment`, `--prod`, or `--meta githubCommitSha=<sha>` when available.
- For a deployment watch or event automation, call the `vercel_deployment` plugin tool with the project name and optional team slug or ID. Omit `commitSha` to watch every deployment for the project; add `target` (`production`, `preview`, or `staging`) to limit the watch to one environment; add a full 40-character `commitSha` to watch one deployment (`target` defaults to `production` when omitted with a commit). The tool resolves the canonical project ID through Vercel before Junior creates the conversation subscription or event automation.
- Use `--follow` only when the user asks for live logs, and stop once enough evidence is captured. Do not leave a streaming command running indefinitely.

3. Bound and minimize output:

- Always use a time window for log searches. Default to the last hour for "right now" incidents and the last 24 hours for retrospective deployment investigations.
- Prefer JSON output for `vercel logs` when parsing or summarizing.
- Keep page sizes small. Start with 20 log lines or fewer unless the user asked for more.
- Quote only the minimum log text needed as evidence. Vercel logs may contain customer data, secrets, request headers, or other sensitive payloads.

4. Report the result:

- Answer the user first with deployment status, error pattern, top failing route/function, or the absence of matching logs.
- Include the project, environment, deployment, time window, and filters used.
- Include Vercel deployment or dashboard URLs when the CLI output provides them. Do not fabricate URLs from incomplete IDs.

## Failure handling

- Missing `JUNIOR_VERCEL_TOKEN`: tell the operator to add `JUNIOR_VERCEL_TOKEN` to the Junior deployment environment and redeploy.
- `401`, invalid token, expired token, or revoked token: report that the configured Vercel token cannot authenticate.
- `403` or permission denied: report that the configured Vercel token or service account cannot read the requested project/deployment/logs. Do not guess missing Vercel permission scopes.
- Project not found: confirm `vercel.project`, `vercel.team`, and the user-provided project name or scope.
- Rate limiting or transient network failure: retry the same bounded read command once. If it still fails, report the throttle or network failure and stop.
- Unsupported mutation request: explain the supported Preview scope. Production deploys, environment edits, and arbitrary domain changes remain unavailable.
