## 1. Backfill

- [x] 1.1 Inventory configuration service/defaults/validation, runtime merge paths, `jr-rpc`, provider default shortcut, resume read-only config, plugin config-key validation, and tests.
- [x] 1.2 Review prior art for non-secret config maps and scoped runtime configuration.
- [x] 1.3 Identify implemented behavior, intended behavior, undefined behavior, and verification ownership.
- [x] 1.4 Write OpenSpec requirements and scenarios for `channel-configuration`.
- [x] 1.5 Create verification map for current tests/evals and gaps.
- [x] 1.6 Validate OpenSpec change with `openspec validate`.

## 2. Deferred Follow-Up

- [ ] 2.1 Decide whether per-conversation `set` must require registered plugin config keys.
- [ ] 2.2 Define authorization rules for who may mutate conversation configuration.
- [ ] 2.3 Decide whether `expiresAt` should be enforced or removed from the entry contract.
- [ ] 2.4 Decide whether provider-specific config values need schemas.
- [ ] 2.5 Decide how configuration should be exposed in prompt/context summaries without leaking private operational data.
