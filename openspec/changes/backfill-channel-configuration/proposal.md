# Backfill `channel-configuration`

## Why

Channel configuration is the mutable non-secret configuration surface that lets provider plugins and workflows use per-conversation defaults such as `github.repo`. It is currently implemented across the configuration service, install-wide defaults, `jr-rpc`, direct provider-default parsing, prompt/runtime context merging, plugin config-key validation, and tests, but has no dedicated canonical prose spec.

## What

- Backfill an OpenSpec capability for `channel-configuration`.
- Inventory configuration service/types/validation/defaults, runtime context merging, `jr-rpc` config commands, provider default handling, plugin config-key validation, resume read-only config, and tests.
- Define normative requirements for:
  - configuration key/value validation
  - conversation-scoped storage
  - install-wide defaults
  - precedence and runtime projection
  - `jr-rpc config` commands
  - provider default natural-language shortcut
  - persisted/resumed read-only configuration
  - plugin config-key ownership
  - secret boundaries
  - verification taxonomy
- Record undefined behavior and open questions around authorization, value schema, TTL/expiry, key ownership enforcement at set time, and config visibility.

## Impact

- Canonical capability: `channel-configuration`
- Related capabilities:
  - `plugin-manifest`
  - `plugin-runtime`
  - `agent-prompt`
  - `sandbox-tools`
  - `slack-agent-delivery`
  - `credential-injection`

## Non-Goals

- Provider-specific meaning of configuration keys.
- Secret storage or credential injection.
- Slack admin authorization policy.
- UI/App Home configuration management.
- Changing runtime behavior.
