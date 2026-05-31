# Backfill Provider Package Specs

## Why

Junior ships first-party provider packages for GitHub, Sentry, Linear, Notion, Datadog, Hex, and agent-browser. These packages are the public installation boundary for provider-specific manifests, skills, runtime dependencies, hosted MCP endpoints, auth declarations, and optional trusted hooks.

The existing plugin manifest, plugin runtime, plugin auth, MCP runtime, skill runtime, and release specs cover much of the machinery, but they do not define the product-facing contract for first-party provider packages as publishable artifacts. That leaves room for drift between `plugin.yaml`, package `files`, public docs, skill instructions, external provider auth models, eval scope, and runtime setup.

## What Changes

- Add a `provider-packages` baseline spec for first-party provider package shape, packaging, manifest alignment, docs, skills, auth declarations, runtime dependencies, hosted MCP endpoint declarations, trusted hooks, and verification expectations.
- Record the current provider package inventory and classify packages by integration shape:
  - host/API credential packages: GitHub, Sentry, Datadog
  - hosted MCP packages: Linear, Notion, Hex
  - runtime-heavy CLI/browser packages: agent-browser
  - trusted hook package: GitHub
- Define when behavior belongs in this shared provider package spec versus a provider-specific workflow spec.
- Identify undefined behavior and follow-up decisions for per-provider workflow backfills.

## Out of Scope

- Rewriting provider skills or package manifests.
- Backfilling every provider's detailed workflow behavior in this change.
- Defining package release automation or version bump policy beyond package artifact requirements.
- Defining generic manifest schema details already owned by `plugin-manifest`.
- Defining OAuth resume mechanics already owned by `oauth-flows`, `plugin-auth`, and `agent-session-resumability`.

## Impact

Provider package work will have a canonical spec for deciding whether a change is a packaging/runtime contract change or a provider workflow behavior change. Future provider-specific specs can build on this baseline without re-specifying common package rules.
