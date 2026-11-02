---
name: junior-qa
description: Validate Junior changes through local app-facing paths. Use for local client or agent QA, dashboard mock reporting UI QA, Docker sandbox provider QA (also from inside a Vercel Sandbox), PR readiness, plugin CLI commands, skill/tool/prompt/plugin behavior, and behavior that tests do not cover well but can be exercised with `pnpm cli -- chat ...`, another `pnpm cli` command, or `JUNIOR_DASHBOARD_MOCK_CONVERSATIONS=true pnpm dev`.
---

Use the local Junior CLI to exercise behavior the test suite does not prove well.
The goal is to run the same app-facing path a developer or operator would use
from `apps/example`, inspect the result, and report concrete evidence.

Start by reading `packages/junior/src/chat/local/AGENTS.md`. Read the owning
package or module `AGENTS.md` when the changed behavior belongs elsewhere.

## Running the Local CLI

Use the repo wrapper so commands run from `apps/example` with root and app env
loaded. Pick the command and prompt that exercise the changed behavior; do not
treat any example prompt here as the required QA:

```sh
pnpm cli -- chat -p "<targeted prompt>"
```

For agent behavior, prompts, skills, tools, and model-facing plugin behavior,
use `chat -p` or interactive `chat` with a prompt that naturally exercises the
change. A trivial exact-output prompt is only useful when the requested check is
limited to proving the local runner starts and delivers one response.

For host or plugin CLI behavior, call the command directly through the same
wrapper:

```sh
pnpm cli -- memory search --scope personal --scope-key local:local-cli --limit 5
```

Use example app discovery probes when the change touches skill or plugin
discovery:

```sh
pnpm cli -- chat -p "/example-local confirm local QA discovery"
pnpm cli -- chat -p "/example-bundle-help"
```

Healthy startup usually logs `SOUL.md`, `WORLD.md`, loaded plugins, and
discovered skills. Treat those logs as useful evidence that the example app path
was exercised.

## Dashboard UI QA

For dashboard UI changes that depend on reporting payload shape, use the typed
mock reporting overlay before relying on ad-hoc local conversations:

```sh
JUNIOR_DASHBOARD_MOCK_CONVERSATIONS=true pnpm dev
```

Then open the dashboard in a browser and exercise the relevant conversation,
transcript, search, or conversation stats surface. The mock overlay returns
read-only `@sentry/junior/reporting` conversation API-shaped data, including
dashboard QA edge cases such as activity-only tool rows and inverted tool
timestamps. It also includes an advisor tool call/result paired with advisor
subagent activity so transcript rendering can be checked against nested tool
activity without manufacturing a live agent run. Use it when a UI change needs
deterministic reporting records that are hard to produce through a live local
chat. Plugin report data is pass-through from the configured reporting provider
and needs separate validation.

The root dev command owns local auth-disabled defaults and the production-like
Nitro preset. If it fails to start, diagnose or report the dev runner failure;
do not change `apps/example/nitro.config.ts`, dashboard auth settings, or OAuth
configuration to make visual QA run.

Do not treat mock dashboard data as proof of runtime ingestion, Slack delivery,
credential behavior, or model behavior. Pair it with local CLI or integration
tests when the changed contract crosses those boundaries.

## Docker Sandbox QA

Use the Docker sandbox provider when the change touches sandbox, egress, or
snapshot behavior, or when no Vercel Sandbox credentials are available. Give
the settings to the process that starts Junior:

```sh
JUNIOR_SANDBOX_PROVIDER=docker pnpm dev
```

To prove the provider itself, run its live test. It needs a Docker daemon, and
the first run builds the `junior-sandbox-runtime` image:

```sh
JUNIOR_DOCKER_SANDBOX_TEST=1 pnpm --filter @sentry/junior exec vitest run tests/integration/docker-sandbox-provider.test.ts
```

A Docker sandbox has a small toolset: `gh`, `jq`, and `rg`. It does not have
other plugin CLIs, browsers, or Docker. Install a missing tool with `sudo`, for
example `sudo npm i -g vercel`. A plain `npm i -g` fails with `EACCES`. Do not
QA browser or Docker-in-sandbox behavior with this provider.

### Inside a Vercel Sandbox

A Vercel Sandbox sends some HTTPS traffic through a TLS proxy. For example,
`ai-gateway.vercel.sh` gets a certificate from `Vercel Network Proxy CA`. A
Docker sandbox inside the Vercel Sandbox has its own trust store. It does not
trust that CA, so its requests to those hosts fail certificate checks.

Before you start Junior, find out if you are in this environment:

```sh
openssl x509 -noout -subject \
  -in /etc/pki/ca-trust/source/anchors/vercel-proxy-ca.pem
```

If the subject is `CN=Vercel Network Proxy CA`, give that one file to the
process as the extra CA:

```sh
JUNIOR_SANDBOX_PROVIDER=docker \
JUNIOR_DOCKER_SANDBOX_EXTRA_CA_CERTS=/etc/pki/ca-trust/source/anchors/vercel-proxy-ca.pem \
  pnpm dev
```

Use the same settings for `pnpm cli -- chat ...` and the live provider test.

Rules:

- Set `JUNIOR_DOCKER_SANDBOX_EXTRA_CA_CERTS` only when the file exists and has
  that subject. On a developer workstation, do not set it, unless that machine
  has its own TLS proxy.
- Do not write the setting to `.env`, `.env.local`, or other repo files. It is
  correct only for this environment.
- Give the proxy CA file, not the full system CA bundle. Junior always adds its
  own egress CA, and the Docker sandbox keeps its public CAs.

### Prewarm the Sandbox Snapshot

The first sandbox builds a dependency snapshot. This build takes about 1
minute and makes an image of about 840 MB. Later sandboxes start from that
snapshot in a few seconds. Build the snapshot before the first QA turn, so the
turn does not wait for it.

After you pull new commits, build all packages before you start the dev
server. `pnpm dev` rebuilds only core and the dashboard, so other plugin
packages can keep old builds:

```sh
pnpm build
```

Start `pnpm dev` with the Docker settings. When the dev server is ready, run
`snapshot create` with the same state settings as the dev server. With the
BullMQ queue, the dev server keeps the snapshot pointer in the Compose Redis.
`pnpm cli` uses memory state by default, so it cannot find that pointer:

```sh
JUNIOR_STATE_ADAPTER=redis \
REDIS_URL=redis://localhost:6382 \
JUNIOR_SANDBOX_PROVIDER=docker \
JUNIOR_DOCKER_SANDBOX_EXTRA_CA_CERTS=/etc/pki/ca-trust/source/anchors/vercel-proxy-ca.pem \
  pnpm cli -- snapshot create
```

On a developer workstation, remove the
`JUNIOR_DOCKER_SANDBOX_EXTRA_CA_CERTS` line. Use the rules in "Inside a Vercel
Sandbox".

The last output line shows the result. `cache_hit=true` means the snapshot was
already ready. `resolve_outcome=rebuilt` means the command built it.

Rules:

- Set the state settings only for this command. Do not change the defaults of
  `pnpm cli`. Local chat uses memory state, so it works without Redis.
- If you run the command without the Redis settings, it builds a second
  snapshot that the dev server does not use.
- A snapshot stays valid until its dependency list changes or its image is
  deleted.

## Choosing a Probe

Pick the smallest local CLI run that demonstrates the changed behavior:

- Prefer a targeted prompt or direct CLI command tied to the modified feature.
- Use exact-output prompts for simple agent routing or prompt-context checks.
- Use natural-language prompts when the behavior is an agent/tool workflow.
- Use direct plugin commands when the behavior is an operator CLI surface.
- Use interactive `pnpm cli -- chat` when continuity across turns matters.
- Use dashboard mock reporting when the behavior is dashboard rendering,
  filtering, search, or metrics over reporting API payloads.
- Do not use local CLI to claim Slack-only behavior, such as Slack formatting,
  delivery retries, reactions, files, or OAuth UI.

Automated tests, typechecks, linters, and evals are separate validation. They do
not replace local QA evidence from running the client or agent.

## OAuth Flow QA (MCP and Plugin)

Junior has two OAuth pause/resume flows:

- Plugin (non-MCP) OAuth: sandbox egress `auth_required` signal resumes via
  `/api/oauth/callback/<provider>`. In `apps/example` the `sentry` plugin is
  the OAuth-manifest provider (`SENTRY_CLIENT_ID`/`SENTRY_CLIENT_SECRET`).
- MCP OAuth: a remote MCP server 401 challenge resumes via
  `/api/oauth/callback/mcp/<provider>`. In `apps/example` the `linear`,
  `notion`, and `hex` plugins use remote MCP URLs.

The local CLI prints the private authorization URL, waits for the provider
callback, and resumes the same turn as the `local-cli` user. Keep `pnpm dev`
running so the configured public callback and tunnel can verify the signed
local state and redirect the browser to the CLI's loopback listener.

Before starting the chat command:

1. Keep one `pnpm dev` process running in the foreground.
2. Confirm only one Cloudflare tunnel for this development hostname is active.
3. Probe both callback hops. Each request should reach Junior and return `400`
   because the probe intentionally omits OAuth state:

```sh
curl -sS -o /dev/null -w '%{http_code}\n' \
  http://127.0.0.1:3000/api/oauth/callback/mcp/linear
curl -sS -o /dev/null -w '%{http_code}\n' \
  https://junior-dev.sentry.cool/api/oauth/callback/mcp/linear
```

Do not present an authorization URL until both probes return `400`. A public
`502` means the tunnel is running without a reachable local server; restart the
dev command and re-run both probes before creating a fresh OAuth attempt.

```sh
pnpm cli -- chat -p "Use the linear skill to list Linear teams."
```

Expect an authorization URL on stderr. Complete the provider flow in a browser;
the same CLI process should then continue the blocked request and print its
reply without requiring the prompt again.

Use the integration tests as the check for local resume behavior and for the
callback route. Use the auth integration evals as the check for Slack and
dashboard resume behavior:

```sh
pnpm --filter @sentry/junior exec vitest run tests/integration/local-agent-runner.test.ts
pnpm --filter @sentry/junior exec vitest run tests/integration/oauth-callback.test.ts
pnpm --filter @sentry/junior-evals evals:integration evals/integration/auth
```

For SQL conversation storage changes, verify the resumed turn rebuilds context
from SQL, not `thread-state` mirrors: conversation context must hydrate from
`junior_conversation_messages` (`hydrateConversationMessages`) and pi history
from `junior_conversation_events` through the Pi adapter (`loadProjection`). In
those tests, transcripts seeded only into `thread-state` must also be persisted
to SQL (`persistConversationMessages`) before the callback runs, and the
resumed agent-run input `conversationContext` must contain the SQL-seeded
messages.

## Failure Handling

If local chat fails because credentials are missing or expired, refresh the
environment when appropriate with `pnpm dev:env`, then rerun the same command.
If local chat fails with a `junior_conversation_messages` or
`junior_conversation_events` query error, the local Postgres schema predates the
SQL conversation storage cutover; run `pnpm cli -- upgrade`, then rerun.
If commands in a Docker sandbox fail certificate checks for a host that the
Vercel Sandbox proxies, the extra CA is not set. See "Inside a Vercel Sandbox".
If startup fails with `Junior plugin "<name>" events is invalid` or a similar
plugin error after a pull, the plugin packages have old builds. Run
`pnpm build`, then start the dev server again.
If the first sandbox command waits for about a minute, the dependency snapshot
is being built. See "Prewarm the Sandbox Snapshot".
If Redis errors appear during ordinary local QA, check whether
`JUNIOR_STATE_ADAPTER=redis` was set; local chat normally defaults to memory
state.
If OAuth returns `502`, verify port 3000 is listening and remove stale duplicate
dev servers or tunnel clients before retrying. If the provider says the
authorization expired, discard that URL and start a fresh chat attempt after
the callback health checks pass.

If the model answer is too loose to prove the behavior, use a narrower prompt,
an exact-output prompt, interactive mode, or a direct plugin CLI command. If the
behavior cannot be exercised through the local client/agent, say local QA is
insufficient and name the runtime surface that still needs manual coverage.

## Reporting

Report:

- the exact `pnpm cli -- ...` commands run
- for dashboard mock QA, the dev-server command, URL, mock conversation or page
  inspected, and the visible UI evidence
- exit status and the key output that proves the behavior
- whether `apps/example` loaded the expected app/plugin/skill path
- whether local QA was sufficient, or what remains unproven locally

Keep any automated test/lint/typecheck/eval results in a separate validation
section so they are not confused with local QA.
