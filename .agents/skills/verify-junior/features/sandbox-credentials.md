# Sandbox credentials

A command in a Sandbox, such as `gh`, git, the `sentry` CLI, a script, or the browser, calls a provider API. The Sandbox holds only placeholders. When the request leaves the Sandbox, Junior adds the credential that the plugin chooses, but only when the request asks for one. Intent and rules: `design/sandbox-credentials.md`.

## Claims

- `env-placeholder` A command prints its env. Auth env vars such as `SENTRY_AUTH_TOKEN` show a placeholder, not a token. Proof: `test` with `pnpm --filter @sentry/junior exec vitest run tests/component/handlers/sandbox-egress-proxy.test.ts -t "resolves command env for every registered sandbox provider|does not invent token env placeholders for domain-only providers"`.
- `declared-domains` Only domains that a plugin declares go to Junior for a credential. Other traffic leaves the Sandbox unchanged, and two plugins cannot own one domain. Proof: `test` with `pnpm --filter @sentry/junior exec vitest run tests/unit/sandbox/vercel-network-policy.test.ts tests/component/plugins/plugin-registry-packages.test.ts -t "forwards credentialed domains and transforms trace domains|keeps every other domain open|rejects provider domains claimed by multiple plugins"`.
- `placeholder-only` A request that sends the plugin's placeholder, also as a Basic auth password, gets the credential. A request without it goes upstream with no credential and no prompt to connect. Proof: `test` with `pnpm --filter @sentry/junior exec vitest run tests/integration/sandbox-egress-proxy.test.ts -t "sandbox-credentials#placeholder-only"`.
- `own-credential-kept` A request that carries its own credential, such as a test login token or a browser session cookie, reaches the provider with that credential, and Junior adds none. Proof: `test` with `pnpm --filter @sentry/junior exec vitest run tests/integration/sandbox-egress-proxy.test.ts -t "sandbox-credentials#own-credential-kept"`.
- `browser-none` A request from a browser in the Sandbox gets no credential, even when it sends the placeholder or its plugin's tools send none. Proof: `test` with `pnpm --filter @sentry/junior exec vitest run tests/integration/sandbox-egress-proxy.test.ts -t "sandbox-credentials#browser-none"`.
- `tools-send-none` A request with no credential gets one only when its plugin says that its tools send none. A git push to GitHub works with no token in the Sandbox. Proof: `test` with `pnpm --filter @sentry/junior exec vitest run tests/integration/sandbox-egress-proxy.test.ts -t "sandbox-credentials#tools-send-none|forwards a Git branch push with its pack bytes and records its refs"`.
- `policy-any-credential` The plugin's egress policy applies to every request to its domains, also to one that carries its own credential. Proof: `test` with `pnpm --filter @sentry/junior exec vitest run tests/integration/sandbox-egress-proxy.test.ts -t "sandbox-credentials#policy-any-credential"`.
- `bound-credential` One Actor's credential never serves another Actor, and a Sandbox cannot use a credential context that Junior did not bind to it. Proof: `test` with `pnpm --filter @sentry/junior exec vitest run tests/component/handlers/sandbox-egress-proxy.test.ts -t "issues separate user credentials per actor|rejects unbound delegated credential subjects under signed egress contexts|requires OIDC before forwarded routing details"`.
- `least-access-read` A Sentry API read uses the plugin's own org read access when it has one, not the Actor's account. Proof: `test` with `pnpm --filter @sentry/junior-sentry exec vitest run tests/org-read.test.ts -t "uses the org read token for reads and user OAuth for writes"`.
- `unknown-write-denied` A GitHub or Sentry write that the plugin does not know is denied before Junior adds the Actor's credential. Proof: `test` with `pnpm --filter @sentry/junior exec vitest run tests/integration/sandbox-egress-proxy.test.ts -t "denies raw GitHub REST issue creation before credential injection|denies raw GitHub GraphQL issue creation before credential injection"` for GitHub, and `test` with `pnpm --filter @sentry/junior-sentry exec vitest run tests/egress-policy.test.ts -t "sandbox-credentials#unknown-write-denied"` for Sentry.
- `connect-prompt` A request that asks for a credential that the Actor has not connected gets a 401 with the auth-required marker, and the command asks the person to connect. Proof: `test` with `pnpm --filter @sentry/junior exec vitest run tests/integration/sandbox-egress-proxy.test.ts -t "returns auth-required via canonical egress credential error when broker has no user token"`.
- `setup-no-credentials` A Workspace setup script runs after Junior removes the credential route. Proof: `test` with `pnpm --filter @sentry/junior exec vitest run tests/unit/sandbox/workspace-setup-command.test.ts -t "removes credential egress before repository finalization"`.
- `sentry-no-uploads` Sandbox code cannot create a Sentry release or upload sourcemaps or debug files with the Actor's account. Proof: `test` with `pnpm --filter @sentry/junior-sentry exec vitest run tests/egress-policy.test.ts -t "sandbox-credentials#sentry-no-uploads"`.
- `sentry-no-delete` Junior never deletes a Sentry organization, project, or user, whatever the credential. Proof: `test` with `pnpm --filter @sentry/junior-sentry exec vitest run tests/egress-policy.test.ts -t "denies DELETE|denies protected deletes for a request that carries its own credential"`.

## How to get to it

- Sandbox commands: `bash`, git, `gh`, the `sentry` CLI, scripts, and the browser.
- Slack: the prompt to connect an account after a command needs one.
- Dashboard: Settings, Identities, to connect or disconnect an account.
- Runtime triggers: each request from the Sandbox to a plugin domain, through `/api/internal/sandbox-egress/<token>`.

## Driving it with proofs.mjs

Preconditions:

- Compose Postgres is healthy (`docker compose up -d --wait postgres redis`).
- `pnpm build` ran after the last pull, and the run directory is `$RUN_DIR`.

- **All claims with a proof: run the tests.** Run `node .agents/skills/verify-junior/scripts/proofs.mjs run --out $RUN_DIR/evidence/sandbox-credentials .agents/skills/verify-junior/features/sandbox-credentials.md`. Each command exits `0`. `summary.tsv` lists each command, its exit code, and the claims it proves.

## Gotchas

- The tests send requests the way the Vercel network policy forwards them, with a faked OIDC check. A live drive needs a Vercel Sandbox, a public `JUNIOR_BASE_URL`, and a connected provider account.
- A test plugin from `@sentry/junior-github` runs from its `dist`. Run `pnpm build` after you change a plugin manifest, or the tests use the old one.

## Gaps

- No test runs a provider CLI in a Turn with no skill loaded, so "credentials come from the installed plugins, not from loaded skills" has no proof.
