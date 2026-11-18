# Sandbox credentials

A user asks Junior to run a command in its Sandbox that calls a provider API, such as `curl`, git, `gh`, the `sentry` CLI, or a browser. The Sandbox holds only placeholders. When the request leaves the Sandbox, Junior adds the Actor's credential only when the request asks for it, keeps a credential that the request brought, and lets the plugin deny writes that it does not know. Intent and rules: `design/sandbox-credentials.md`.

## Sub-features

- `env-placeholder` A command prints an auth env var, such as `SENTRY_AUTH_TOKEN`. It shows a placeholder, not a token.
- `placeholder-only` A request without the placeholder goes to the provider with no credential, and Junior asks nobody to connect.
- `connect-prompt` A request that sends the placeholder, when the Actor has not connected that provider, gets a 401 that names the provider, and Junior asks the user to connect it.
- `own-credential-kept` A request that brings its own token or cookie reaches the provider with it. Junior adds nothing.
- `browser-none` A browser request never gets a credential, also when it sends the placeholder.
- `tools-send-none` A plugin that says its tools send no credential, such as GitHub for git, gets one on a request that sends none. A git command works with no token in the Sandbox.
- `policy-any-credential` The plugin's egress policy applies to every request to its domains, also to one that brings its own credential.
- `unknown-write-denied` A Sentry write that the plugin does not know is denied before Junior adds the Actor's credential. A request with its own token is not limited.
- `sentry-no-uploads` Creating a Sentry release or uploading sourcemaps or debug files with the Actor's account is denied.
- `sentry-no-delete` Deleting a Sentry organization, project, or user is denied, whatever the credential.

## How to get to it (user POV)

- Ask Junior, in a dashboard Conversation or in Slack, to run a command in its Sandbox.
- The transcript: the command output that Junior shows, and the prompt to connect an account.
- Dashboard: `Conversation menu`, then `Open event log`, for the `bash` tool calls.
- Dashboard: `Settings`, `Identities`, to connect or disconnect an account.

## Driving it with browse.mjs

Preconditions:

- No Vercel Sandbox credentials, so launch with `JUNIOR_SANDBOX_PROVIDER=docker node $S/instance.mjs launch` (no `--mock`). Inside a Vercel Sandbox, also set the extra CA that the `junior-qa` skill names. `instance.mjs doctor` passes.
- The dashboard viewer has not connected Sentry in `Settings`, `Identities`.
- `E=$RUN_DIR/evidence/sandbox-credentials` and `C='role=textbox[name="Start a conversation"]'`.

- **Placeholder in the env (`env-placeholder`).** Run `node $S/browse.mjs --out $E/env --timeout 300000 --goto / --fill "$C=Run printenv SENTRY_AUTH_TOKEN in your sandbox and show me the raw output in a code block." --press Enter --idle --expect 'text=host_managed_credential' --snap reply --click 'role=button[name="Conversation menu"]' --click 'role=menuitem[name="Open event log"]' --expect 'button:has-text("tool_calls"):has-text("bash")' --snap log`. The output is `host_managed_credential`, and the event log has the `bash` call.
- **Requests that do not ask (`placeholder-only`, `own-credential-kept`, `browser-none`).** Run `node $S/browse.mjs --out $E/no-ask --timeout 300000 --goto / --fill "$C=Run these three commands in your sandbox exactly as written and show me the raw output of each in a code block: curl -s -w ' none=%{http_code}' https://sentry.io/api/0/organizations/ ; curl -s -w ' own=%{http_code}' -H 'Authorization: Bearer verify-junior-own-token' https://sentry.io/api/0/organizations/ ; curl -s -w ' browser=%{http_code}' -H 'Sec-Fetch-Mode: navigate' -H 'Authorization: Bearer host_managed_credential' https://sentry.io/api/0/organizations/" --press Enter --idle --expect 'text=none=401' --expect 'text=own=401' --expect 'text=browser=401' --absent 'text=junior-auth-required' --snap reply --click 'role=button[name="Conversation menu"]' --click 'role=menuitem[name="Open event log"]' --expect 'button:has-text("tool_calls"):has-text("bash")' --snap log`. Each body is Sentry's own 401 JSON. No output has a `junior-auth-required` line, and Junior does not ask to connect Sentry.
- **Request that asks (`connect-prompt`).** Run `node $S/browse.mjs --out $E/ask --timeout 300000 --goto / --fill "$C=Run this command in your sandbox exactly as written and show me the raw output in a code block: curl -s -w ' placeholder=%{http_code}' -H 'Authorization: Bearer host_managed_credential' https://sentry.io/api/0/organizations/" --press Enter --idle --expect 'text=/junior-auth-required provider=sentry/' --snap reply`. The output starts with `junior-auth-required provider=sentry`, and Junior asks you to connect Sentry with a link.
- **Sentry writes (`sentry-no-uploads`, `unknown-write-denied`, `sentry-no-delete`, `policy-any-credential`).** Run `node $S/browse.mjs --out $E/writes --timeout 300000 --goto / --fill "$C=Run these four commands in your sandbox exactly as written and show me the raw output of each in a code block. The org and project do not exist. curl -s -w ' release=%{http_code}' -X POST -H 'Authorization: Bearer host_managed_credential' -H 'Content-Type: application/json' -d '{\"version\":\"verify-junior\"}' https://sentry.io/api/0/organizations/verify-junior/releases/ ; curl -s -w ' unknown=%{http_code}' -X POST -H 'Authorization: Bearer host_managed_credential' https://sentry.io/api/0/organizations/verify-junior/integrations/ ; curl -s -w ' own-release=%{http_code}' -X POST -H 'Authorization: Bearer verify-junior-own-token' https://sentry.io/api/0/organizations/verify-junior/releases/ ; curl -s -w ' delete=%{http_code}' -X DELETE -H 'Authorization: Bearer verify-junior-own-token' https://sentry.io/api/0/projects/verify-junior/verify-junior/" --press Enter --idle --expect 'text=release=403' --expect 'text=unknown=403' --expect 'text=own-release=401' --expect 'text=delete=403' --snap reply`. `release` says that creating Sentry releases with the requester's account is blocked. `unknown` says that the write is blocked because it would use the requester's account. `own-release` is Sentry's own 401, so the deny did not apply to a request with its own token. `delete` says that deleting a Sentry project is blocked, also with its own token. No body has `junior-auth-required`.
- **GitHub with no token (`tools-send-none`).** Needs the GitHub App preconditions in `github.md` and a private scratch repo `$REPO`. Run `node $S/browse.mjs --out $E/git --timeout 300000 --goto / --fill "$C=Run env | grep -c GITHUB_TOKEN= ; git ls-remote https://github.com/$REPO HEAD in your sandbox and show me the raw output in a code block." --press Enter --idle --expect 'text=/[0-9a-f]{40}\s+HEAD/' --snap reply`. The Sandbox has no real GitHub token, and `git ls-remote` prints the `HEAD` commit of the private repo.

## Gotchas

- With no Sandbox provider, every command fails with an OIDC credentials error. That is a missing precondition, not a credential failure.
- The agent can rewrite or decline a command that looks risky, such as the `DELETE`. Check the `bash` row in the event log for the command that ran. Report a declined or changed command as a failed drive, with Junior's reply. Do not count it as a deny.
- Guardian can ask before a `bash` call that sends a write. Answer `Yes, run it. The org and project do not exist.` The deny must come from the command output, not from Guardian.
- `connect-prompt` needs `SENTRY_CLIENT_ID` and `SENTRY_CLIENT_SECRET` in `.env.local`, or Junior cannot make a connect link. Without them, the output still has the `junior-auth-required` line.
- If the viewer connected Sentry, `connect-prompt` gets a real Sentry response, and `release` and `unknown` still show 403. Disconnect in `Settings`, `Identities` first.
- The org `verify-junior` must not be one that the viewer can write to. A request that is not denied goes to Sentry.
- A Docker Sandbox does not have a browser. `browser-none` sends the browser header with `curl`, the same header that Chromium under Playwright sends.
