# Skill Capability and Credential Injection Spec

## Status

Draft

## Related

- [Security Policy](./security-policy.md)

## Purpose

Define a simple capability model where skills declare required capabilities and runtime injects short-lived provider credentials as env vars for sandbox command execution.

## Core model

1. Skill loads normally.
2. Runtime reads `requires-capabilities` from active skill.
3. For privileged command execution, runtime issues short-lived credentials for required capabilities.
4. Runtime injects credentials as env vars for that command (for example `GITHUB_TOKEN`).
5. Runtime does not persist long-lived secrets in sandbox or skill files.

## Skill contract

Skills declare required capabilities in frontmatter.

```yaml
---
name: gh-issue
description: Create and update GitHub issues.
requires-capabilities: github.issues.read github.issues.write
---
```

Rules:

- `requires-capabilities` is optional.
- Value is a whitespace-delimited token list.
- Tokens must match `^[a-z0-9]+(\.[a-z0-9-]+)+$`.
- Skills must never include secret values.

## Runtime contract

### Capability resolution

- Resolve capabilities from active skill only.
- Resolve target context (for GitHub: `owner/repo`) from invocation/command context when available.

### Credential issuance

- Use provider-specific broker implementations.
- Return short-lived leases only.
- Keep lease reuse in memory only.

### Injection behavior

- Injection happens at command execution time, not at skill-load time.
- Inject env vars only for that command execution scope.
- Do not write long-lived credentials into sandbox files.
- `jr-rpc credential issue` must return metadata only; never include raw token values.

### Capability coalescing

- When multiple GitHub capabilities are required in one command, runtime should issue one GitHub token lease at the highest required level and inject a single `GITHUB_TOKEN`.

## GitHub profile

### Capabilities

- `github.issues.read`
- `github.issues.write`
- `github.issues.comment`
- `github.labels.write`

### Issuance flow

1. Host runtime signs a GitHub App JWT using `GITHUB_APP_ID` + `GITHUB_APP_PRIVATE_KEY`.
2. Runtime exchanges JWT for installation token.
3. Runtime injects `GITHUB_TOKEN` for sandbox command execution.

### Lease behavior

- Prefer short-lived token leases.
- Runtime cache can reuse a lease in memory.
- Current cap: at most 1 hour lease window.

## Observability

Emit events without secret material:

- `credential_issue_request`
- `credential_issue_success`
- `credential_issue_failed`
- `credential_inject_start`
- `credential_inject_cleanup`

## Non-goals

- External policy/config systems for capability allowlists.
- Persistent token stores.
- Multi-provider policy engines.

## Backward compatibility

- Skills without `requires-capabilities` continue to work unchanged.
