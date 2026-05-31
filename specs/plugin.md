# Plugin Architecture Spec

## Metadata

- Created: 2026-03-01
- Last Edited: 2026-05-30

## Purpose

Define the plugin model for provider integrations. Plugins package declarative runtime configuration, optional skills, optional MCP tool sources, and optional trusted hooks without letting skill prose own runtime setup or credentials.

## Scope

- Plugin package/directory shape.
- Ownership boundaries between manifests, skills, runtime loading, credentials, and trusted hooks.
- Links to detailed contracts for manifests, runtime loading, credential injection, and trusted heartbeat/dispatch behavior.

## Non-Goals

- Dynamic plugin loading from untrusted sources.
- Remote marketplace installation.
- Plugin sandboxing for host-trusted runtime code.
- Using MCP as the plugin discovery protocol. MCP is only an optional tool source.

## Core Model

1. A plugin is either a local `plugins/<name>/plugin.yaml` directory or an explicitly declared package that contains `plugin.yaml`, `plugins/`, or `skills/`.
2. Plugin discovery is explicit. Runtime must not scan `node_modules`, `package.json` dependencies, or arbitrary filesystem paths to find plugins.
3. `plugin.yaml` owns runtime setup: provider domains, credentials, API headers, command env, runtime dependencies, postinstall commands, OAuth, MCP endpoints, config keys, and skill roots.
4. Skills consume plugin-provided runtime surfaces. They must not tell the agent to install CLIs, bootstrap package managers, configure credentials, repair sandbox packages, or create MCP server config.
5. Credential delivery is host-owned and requester-bound. Real provider secrets never enter sandbox env vars, files, command args, skill text, model-visible tool args, or logs.
6. Plugin-declared MCP tools are host-managed and activated only after a skill from the same plugin is loaded or the model explicitly requests that provider through the MCP bridge tools.
7. Trusted runtime behavior is app-code registration, not manifest registration. Apps pass trusted `JuniorPlugin` objects to `createApp({ plugins })`.
8. Core prompt text must stay plugin-agnostic. Plugin-specific behavior reaches the model through skill descriptions/bodies, tool descriptions, schemas, `promptSnippet`, `promptGuidelines`, and searched MCP descriptors.

## File Shape

```txt
plugins/sentry/
├── plugin.yaml
└── skills/
    └── sentry/
        └── SKILL.md
```

## Detailed Contracts

- [Plugin Manifest Spec](./plugin-manifest.md): `plugin.yaml` fields, env-var expansion, runtime dependency declarations, and validation.
- [Plugin Runtime Spec](./plugin-runtime.md): discovery/loading, capability catalog integration, MCP activation, plugin skills, and security invariants.
- [Credential Injection Spec](./credential-injection.md): requester-bound provider leases and sandbox egress auth.
- [OAuth Flows Spec](./oauth-flows.md): OAuth challenge, callback, and turn-resume behavior.
- [Sandbox Snapshots Spec](./sandbox-snapshots.md): runtime dependency snapshot build/reuse.
- [Trusted Plugin Heartbeat Spec](./trusted-plugin-heartbeat.md): trusted heartbeat and tool hooks.
- [Trusted Plugin Dispatch Spec](./trusted-plugin-dispatch.md): durable `ctx.agent.dispatch` contract.

## What Stays Core

| Component                                               | Reason                                    |
| ------------------------------------------------------- | ----------------------------------------- |
| Agent loop and harness                                  | Core orchestration, not provider-specific |
| Sandbox/container isolation                             | Shared security boundary                  |
| `jr-rpc` command infrastructure                         | Generic RPC layer                         |
| Slack tools                                             | Platform tools, not provider integrations |
| Web tools                                               | General-purpose tools                     |
| Skill infrastructure                                    | Framework; plugins contribute skills      |
| `CredentialBroker` / `CredentialLease`                  | Shared credential contract                |
| `ProviderCredentialRouter`                              | Generic egress credential router          |
| OAuth callback route (`/api/oauth/callback/[provider]`) | Shared HTTP handler                       |

## Verification

- Plugin package discovery is explicit and deterministic.
- Manifest validation fails startup before partial registration.
- Plugin skills are associated with their parent plugin during discovery.
- Plugin-backed skills cannot forge plugin ownership metadata.
- Core prompt tests/evals confirm plugin-specific behavior is not hard-coded into the platform prompt.

## Related Specs

- `./plugin-manifest.md`
- `./plugin-runtime.md`
- `./credential-injection.md`
- `./trusted-plugin-heartbeat.md`
- `./trusted-plugin-dispatch.md`
- `./sandbox-snapshots.md`
