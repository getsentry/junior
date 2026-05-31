# Design: `channel-configuration` Baseline Backfill

## Sources Reviewed

- `packages/junior/src/chat/configuration/types.ts`
- `packages/junior/src/chat/configuration/service.ts`
- `packages/junior/src/chat/configuration/validation.ts`
- `packages/junior/src/chat/configuration/defaults.ts`
- `packages/junior/src/chat/capabilities/jr-rpc-command.ts`
- `packages/junior/src/chat/services/provider-default-config.ts`
- `packages/junior/src/chat/respond.ts`
- `packages/junior/src/chat/runtime/thread-state.ts`
- `packages/junior/src/chat/runtime/slack-resume.ts`
- `packages/junior/tests/unit/config/configuration-service.test.ts`
- `packages/junior/tests/unit/config/config-defaults.test.ts`
- `packages/junior/tests/unit/handlers/jr-rpc-command.test.ts`
- `packages/junior/tests/integration/slack/provider-default-config-behavior.test.ts`
- `packages/junior/tests/unit/app-config.test.ts`
- Kubernetes ConfigMap docs: https://kubernetes.io/docs/concepts/configuration/configmap/

## Prior-Art Interpretation

- Kubernetes ConfigMaps are useful prior art for separating non-confidential runtime configuration from secrets. Junior channel configuration should store defaults and operational preferences, not tokens or private keys.
- Command-style configuration surfaces should be explicit, scoped, auditable, and return machine-readable results. Junior's `jr-rpc config` commands are a sandbox command bridge, not natural-language model authority.
- Install-wide defaults and per-conversation overrides are a common precedence model: global defaults provide baseline values, while local/channel state wins for the active conversation.

## Design Decisions

### Non-Secret Configuration Only

Configuration keys and values are validated to reject secret-looking names and values. Real provider secrets belong in plugin auth, OAuth, and credential injection surfaces, not channel configuration.

### Conversation Scope Is The Only Persisted Scope Today

The type name and some behavior use "channel", but persisted entries normalize to `scope: "conversation"`. The service also accepts legacy persisted `channel` scope and coerces it to `conversation`.

### Runtime Merge Order Is Explicit

At turn start, effective configuration values are install defaults, then any context-provided configuration, then persisted conversation configuration. Later `jr-rpc config set/unset` updates the in-memory effective configuration for the running turn.

### Plugin Manifests Own Registered Config Keys

Install-wide defaults must reference registered plugin config keys. Direct per-conversation writes currently validate key shape and secret safety but do not require the key to be registered; this is recorded as an open question.

## Risks

- Anyone who can cause agent-executed `jr-rpc config` may mutate conversation configuration unless higher-level tool/use policy prevents it.
- `expiresAt` is stored but not enforced by resolution.
- Value schema is intentionally loose; providers must validate semantics when consuming values.
- Secret-like detection is heuristic and should not be treated as a security boundary for untrusted secrets.

## Verification Approach

- Unit tests own validation, service persistence/coercion, defaults, and `jr-rpc` command parsing/output.
- Integration tests own direct Slack/provider-default shortcuts and runtime configuration use.
- Evals are appropriate only for natural-language behavior that decides to set/use defaults, not deterministic config service mechanics.
