# Provider Catalog Spec

## Metadata

- Created: 2026-02-27
- Last Edited: 2026-03-03

## Changelog

- 2026-03-03: Standardized metadata headers and reconciled spec references/structure.

## Status

Draft — largely superseded by `specs/plugin-spec.md` which now drives the provider catalog model.

## Related

- [Skill Capability and Credential Injection Spec](../skill-capabilities-spec.md)
- [Security Policy](../security-policy.md)

## Purpose

Define the canonical provider catalog model used by runtime, skill validation, and prompts.

This spec answers:

- Which providers exist (for example `github`)
- Which capability tokens each provider supports
- Which non-secret configuration keys each provider exposes
- How provider-specific defaults are exposed (for example a repo config key)

## Core Model

Each provider entry declares:

- `provider`: stable provider identifier
- `capabilities[]`: provider-qualified capability names
- `configKeys[]`: allowed non-secret config keys
- optional `target` metadata (for example repository default key)

## Type Shape

```ts
interface CapabilityProviderTargetDefinition {
  type: string;
  configKey: string;
  commandFlags?: string[];
}

interface CapabilityProviderDefinition {
  provider: string;
  capabilities: string[];
  configKeys: string[];
  target?: CapabilityProviderTargetDefinition;
}
```

## GitHub Initial Provider

```yaml
provider: github
capabilities:
  - github.issues.read
  - github.issues.write
  - github.contents.read
  - github.contents.write
  - github.pull-requests.read
  - github.pull-requests.write
configKeys:
  - github.repo
target:
  type: repo
  configKey: github.repo
  commandFlags:
    - --repo
    - -R
```

## Runtime Contracts

### Capability Routing

- Runtime resolves provider from capability token using catalog.
- Runtime routes issuance to provider broker using provider id.
- Unsupported capability tokens fail explicitly.
- Missing broker registration for a known provider fails explicitly.

### Target Resolution

- If a provider declares a target, runtime may resolve it in this order:
  1. explicit user argument (for example `--target owner/repo`)
  2. provider-declared invocation flag inference (for example `--repo owner/repo`)
  3. provider target config key (for example `github.repo`)

## Skill Metadata Validation

- Plugin manifests define capabilities; skills consume provider config via `uses-config` rather than declaring capabilities.
- `uses-config` values must exist in catalog config keys.
- Invalid values are warn+skip during skill discovery (`skill_frontmatter_invalid`).

## Prompt Contracts

- System prompt should include provider catalog summary so natural language requests can map to valid config/capability tokens.
- Prompt guidance must remain generic and provider-extensible.

## Observability

- Emit `capability_catalog_loaded` at startup (once per process) with:
  - providers
  - capability count and names
  - config key count and keys

## Security Constraints

- Catalog lists only non-secret config keys.
- Provider secrets remain host-managed and are never stored in channel config.
- Credential issuance remains explicit and short-lived per security policy.

## Extension Workflow

To add a new provider:

1. Add provider entry to catalog with capabilities, config keys, and any provider-default metadata.
2. Implement provider credential broker.
3. Register broker in provider router factory.
4. Add tests for:
   - routing
   - skill metadata validation
   - target/config resolution
   - eval behavior (natural-language config set + credential issue path)

## Non-goals

- Full policy engine for provider allow/deny logic.
- Secret storage in provider catalog.
- Transport-specific UX behavior.
