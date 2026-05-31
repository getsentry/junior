## 1. Backfill

- [x] 1.1 Inventory plugin architecture/runtime prose specs, registry, app configuration, package discovery, skills, capability catalog, trusted hook code, and tests.
- [x] 1.2 Review prior art for explicit package discovery, skill loading, MCP lazy provider activation, and trusted host plugin hooks.
- [x] 1.3 Identify implemented behavior, intended behavior, undefined behavior, and verification ownership.
- [x] 1.4 Write OpenSpec requirements and scenarios for `plugin-runtime`.
- [x] 1.5 Create verification map for current tests/evals and gaps.
- [x] 1.6 Validate OpenSpec change with `openspec validate`.

## 2. Deferred Follow-Up

- [ ] 2.1 Decide whether process-global plugin registry mutation should be replaced by app-scoped runtime state.
- [ ] 2.2 Define public compatibility/versioning policy for packaged plugins.
- [ ] 2.3 Decide whether skill discovery cache invalidation should key directly on plugin catalog signatures.
- [ ] 2.4 Decide whether startup validation should eagerly validate local app plugin roots even without configured packages/config defaults.
- [ ] 2.5 Split trusted hook details into `trusted-plugin-heartbeat`, `trusted-plugin-dispatch`, and any future trusted-tool hook spec during consolidation.
