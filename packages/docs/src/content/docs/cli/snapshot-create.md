---
title: "junior snapshot create"
description: "Resolve or rebuild the Junior sandbox snapshot used for runtime dependencies."
type: reference
summary: Resolve the sandbox snapshot profile before deploys that need plugin runtime dependencies.
prerequisites:
  - /start-here/quickstart/
related:
  - /reference/config-and-env/
  - /start-here/quickstart/
  - /cli/check/
  - /cli/upgrade/
  - /operate/sandbox-snapshots/
  - /operate/observability/
---

`junior snapshot create` prepares the sandbox runtime dependencies before the app handles work. The scaffolded `pnpm build` script runs it on every deploy, so you do not run it by hand. It needs Vercel credentials, so run it directly only from a linked project after `vercel env pull`.

## Usage

Run it from a project that already has `@sentry/junior` installed:

```bash
pnpm exec junior snapshot create
```

The command takes no extra arguments.

## What it does

Before resolving the snapshot, the CLI inspects the loaded plugins and summarizes the snapshot inputs:

- Plugin names
- Runtime system dependencies
- Runtime npm dependencies
- Runtime postinstall commands

It then resolves the sandbox snapshot profile, reuses a cached snapshot when possible, or rebuilds the snapshot when the profile changed.

## Example output

Typical logs look like this:

```text
Loaded plugins (2): agent-browser, notion
Sandbox snapshot inputs: plugins=1 system_dependencies=1 npm_dependencies=1 postinstall_commands=1
Snapshot plugins (1): agent-browser
System dependencies (1): gtk3
NPM dependencies (1): agent-browser@latest
Runtime postinstall (1): agent-browser install
Resolving sandbox snapshot profile...
Building sandbox snapshot...
Sandbox snapshot create complete: runtime=node22 resolve_outcome=rebuilt cache_hit=false dependency_count=2 profile_hash=abc snapshot_id=snap_123 rebuild_reason=cache_miss
```

The profile always includes Junior's core sandbox tools, so every build resolves a snapshot. The scaffolded build script runs it:

```json title="package.json"
{
  "scripts": {
    "build": "junior snapshot create && nitro build"
  }
}
```

To build without warmup, such as in CI without Vercel credentials, set
`JUNIOR_SKIP_SNAPSHOT=1`. The scaffolded CI workflow does this. Sandboxes then
build their dependencies on first use.

## Failure behavior

If snapshot resolution fails, the CLI exits non-zero and prints the underlying error:

```text
junior command failed: OIDC missing
```

Treat that as a real deploy blocker. The usual checks are the build environment, `REDIS_URL`, and any platform auth required for snapshot creation.

## Verification

In the Vercel build log:

1. Confirm the final snapshot line includes `Sandbox snapshot create complete`.
2. Verify the reported dependency counts match the plugins you enabled.

## Next step

Run [junior check](/cli/check/) when you change `plugin.yaml` or `SKILL.md`, then deploy with [Deploy to Vercel](/start-here/deploy-to-vercel/).
