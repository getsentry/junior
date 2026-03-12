---
title: "junior snapshot create"
description: "Resolve or rebuild the Junior sandbox snapshot used for runtime dependencies."
type: reference
summary: "`junior snapshot create` inspects plugin runtime dependencies, builds or reuses the sandbox snapshot, and logs the outcome."
prerequisites:
  - /start-here/quickstart/
related:
  - /reference/config-and-env/
  - /start-here/quickstart/
  - /operate/observability/
---

Use `junior snapshot create` when your deployment needs the sandbox runtime dependencies ready before the app starts handling work. This is the command you wire into build-time snapshot warmup.

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

If there is nothing to snapshot, the command still reports the empty profile and completion outcome.

## When to use it

The common case is a Vercel build command:

```json title="package.json"
{
  "scripts": {
    "build": "next build && junior snapshot create"
  }
}
```

Use this when your enabled plugins declare runtime dependencies or postinstall steps that should be prepared ahead of request handling.

## Failure behavior

If snapshot resolution fails, the CLI exits non-zero and prints the underlying error:

```text
junior command failed: OIDC missing
```

Treat that as a real deploy blocker. The usual checks are the build environment, `REDIS_URL`, and any platform auth required for snapshot creation.

## Verification

After adding the command to your build:

1. Run `pnpm exec junior snapshot create` locally or in CI.
2. Confirm the final log line includes `Sandbox snapshot create complete`.
3. Verify the reported dependency counts match the plugins you enabled.

## Next step

Return to [Quickstart](/start-here/quickstart/) to wire the command into Vercel, then monitor deploys with [Observability](/operate/observability/).
