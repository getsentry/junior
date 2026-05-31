# Backfill Worksheet: `channel-configuration`

## Scope

- Capability: Channel configuration
- Change: `backfill-channel-configuration`
- Owner: spec backfill program
- Status: draft
- Canonical target: new `openspec/specs/channel-configuration/spec.md` and a future prose pointer if needed

## Current-Source Inventory

### Existing Specs And Policies

- `specs/plugin-manifest.md`: plugin config-key declarations.
- `specs/plugin-runtime.md`: registered plugin config keys and config defaults validation.
- `specs/security-policy.md`: secret handling boundary.
- `specs/agent-prompt.md`: prompt/context ownership.
- `specs/testing.md`: verification layer ownership.

### Code Paths

- `packages/junior/src/chat/configuration/types.ts`: entry/service/storage contracts.
- `packages/junior/src/chat/configuration/service.ts`: state coercion and set/get/list/resolve/unset.
- `packages/junior/src/chat/configuration/validation.ts`: key syntax and secret-like key/value rejection.
- `packages/junior/src/chat/configuration/defaults.ts`: install-wide defaults and registered plugin key validation.
- `packages/junior/src/chat/capabilities/jr-rpc-command.ts`: sandbox `jr-rpc config` command.
- `packages/junior/src/chat/services/provider-default-config.ts`: direct GitHub repo default shortcut.
- `packages/junior/src/chat/respond.ts`: runtime merge and mid-turn mutation updates.
- `packages/junior/src/chat/runtime/thread-state.ts`: channel id backed configuration service.
- `packages/junior/src/chat/runtime/slack-resume.ts`: read-only resume configuration service.

### Tests And Evals

- Unit:
  - `packages/junior/tests/unit/config/configuration-service.test.ts`
  - `packages/junior/tests/unit/config/config-defaults.test.ts`
  - `packages/junior/tests/unit/handlers/jr-rpc-command.test.ts`
  - `packages/junior/tests/unit/app-config.test.ts`
  - `packages/junior/tests/unit/skills/skill-frontmatter.test.ts`
  - `packages/junior/tests/unit/skills/skills.test.ts`
- Integration:
  - `packages/junior/tests/integration/slack/provider-default-config-behavior.test.ts`
  - Resume and OAuth/MCP tests that assert configuration survives resume.
- Evals:
  - Potential natural-language provider default or provider usage evals.

## Prior Art

- Kubernetes ConfigMaps distinguish non-confidential configuration from Secrets. Junior should follow that split: operational defaults can be stored as configuration, but tokens and private keys must use credential systems.
- Command interfaces for runtime configuration should be deterministic and machine-readable so agents can repair or inspect defaults without guessing storage internals.

Sources:

- Kubernetes ConfigMaps: https://kubernetes.io/docs/concepts/configuration/configmap/

## Implemented Behavior

- Behavior that code currently enforces:
  - Keys must be dotted lowercase namespace keys and must not look secret-related.
  - Values are recursively scanned for secret-like strings/keys up to a depth limit.
  - Entries persist as schema version 1 under `configuration.entries`.
  - Persisted `channel` scope is accepted and normalized to `conversation`.
  - Malformed persisted entries are ignored.
  - Set/get/list/resolve/resolveValues/unset work on trimmed keys and sorted lists.
  - Install defaults must be objects keyed by registered plugin config keys and are returned as clones.
  - Effective turn configuration merges install defaults, explicit context configuration, and persisted conversation configuration.
  - `jr-rpc config` supports get/set/set --json/unset/list and updates in-memory turn config.
  - Direct natural-language GitHub repo default shortcut sets `github.repo`.
  - Resume can project saved configuration through a read-only service.
- Behavior that tests currently verify:
  - Service set/get/list/resolve/unset and secret rejection.
  - Defaults validation and rollback through app config.
  - `jr-rpc` command get/set/list/unset and error cases.
  - Provider default behavior in Slack integration.
  - Deprecated skill `uses-config` rejection.
- Behavior that appears accidental or weakly enforced:
  - Per-conversation `set` does not require registered plugin config key ownership.
  - `expiresAt` is stored but not enforced.
  - Authorization for mutation is not specified.
  - Secret detection is heuristic.
  - Provider value schemas are not enforced centrally.

## Intended Behavior

- Product/runtime behavior that should be normative:
  - Configuration is non-secret.
  - Conversation values override install defaults.
  - Plugin manifests own key registration.
  - `jr-rpc` is the deterministic sandbox command interface.
  - Resume sees configuration values needed to continue the same turn.
- Behavior that should remain implementation detail:
  - Exact secret regex patterns.
  - Exact persisted JSON shape beyond schema version/entries.
  - Exact command stdout formatting if not public API.
  - Exact direct natural-language regex implementation.
- Behavior that should be non-goal:
  - Credential/token storage.
  - Provider-specific validation schemas.
  - Admin UI or Slack modal config flows.

## Undefined Behavior / Open Questions

| Question                                  | Evidence                                                                | Options                                                                   | Recommendation                                               | Status |
| ----------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------ | ------ |
| Must per-conversation keys be registered? | Defaults require registry; service `set` only validates syntax/secrets. | Require registry, allow arbitrary dotted keys, or warn.                   | Require registry when channel has plugin catalog available.  | open   |
| Who may mutate config?                    | `jr-rpc` records requester but does not authorize.                      | Any requester, channel admins, app admins, or capability-specific policy. | Define Slack authorization before exposing broader UX.       | open   |
| Should `expiresAt` be enforced?           | Entry stores `expiresAt`; resolve/list do not filter.                   | Enforce, remove, or reserve.                                              | Reserve until use case exists.                               | open   |
| Should values have provider schemas?      | Values are arbitrary non-secret JSON.                                   | Provider schema, config-key manifest schema, or provider validation.      | Defer to provider-packages unless common bugs appear.        | open   |
| How visible is config to the model?       | Effective config passed into tools/prompt contexts.                     | Full config, filtered config, or only active provider keys.               | Keep minimal projection; review during prompt consolidation. | open   |

## OpenSpec Requirements Draft

| Requirement               | Scenarios                                               | Source Evidence              | Notes                   |
| ------------------------- | ------------------------------------------------------- | ---------------------------- | ----------------------- |
| Key/value validation      | valid, syntax, secret key, secret value                 | validation/service tests     | Non-secret only.        |
| Conversation service      | set/get/list/resolve/unset, legacy, malformed           | service/tests                | Scope normalized.       |
| Install defaults          | undefined, not object, unregistered, clone              | defaults/tests               | Registered plugin keys. |
| Runtime precedence        | defaults/context/persisted, mid-turn update             | respond/tests                | Merge order.            |
| Jr-rpc command            | handled, missing context, get/set/json/unset/list/usage | jr-rpc tests                 | Machine-readable.       |
| Provider default shortcut | GitHub repo, no config, no match                        | provider service/integration | Deterministic only.     |
| Resume projection         | saved config, read-only mutation fail, resolve          | resume tests/code            | Continuity.             |
| Ownership boundaries      | manifest keys, no uses-config, no secrets               | plugin/skill tests           | Cross-spec.             |
| Verification taxonomy     | unit/integration/eval                                   | testing spec                 | Layer map.              |

## Migration Notes

- Canonical spec updates:
  - Add a new canonical channel-configuration spec; no existing prose file was found.
- Index/pointer updates:
  - Add `channel-configuration` to `specs/index.md` and root known specs after acceptance.
- Superseded content:
  - Move config-key ownership notes out of skill docs into this spec plus plugin manifest/runtime.
- Test/eval taxonomy changes:
  - Keep deterministic service/command behavior in unit tests.
  - Use integration/evals only for user-visible natural-language config workflows.

## Validation Notes

- `openspec validate`: passed with `Change 'backfill-channel-configuration' is valid`.
- Targeted tests/evals: intentionally not run for this spec-only backfill; current tests were inventoried but not changed.
- Deferred verification: registered-key enforcement, mutation auth, `expiresAt`, provider value schemas, model-visible projection.
