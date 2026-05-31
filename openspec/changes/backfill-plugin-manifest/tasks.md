## 1. Backfill

- [x] 1.1 Inventory existing prose specs, parser/types, registry/package discovery, CLI validation, tests, and related specs.
- [x] 1.2 Review prior art for package manifests, OAuth declarations, MCP provider declarations, and manifest security boundaries.
- [x] 1.3 Identify implemented behavior, intended behavior, undefined behavior, and verification ownership.
- [x] 1.4 Write OpenSpec requirements and scenarios for `plugin-manifest`.
- [x] 1.5 Create verification map for current tests/evals and gaps.
- [x] 1.6 Validate OpenSpec change with `openspec validate`.

## 2. Deferred Follow-Up

- [ ] 2.1 Decide whether unknown manifest fields should be rejected, preserved for forward compatibility, or explicitly ignored.
- [ ] 2.2 Decide whether plugin-level API headers and MCP headers may contain literal values or must use non-default env-var references for secret-bearing headers.
- [ ] 2.3 Align runtime system URL dependency prose with parser behavior for HTTPS RPM URLs.
- [ ] 2.4 Decide whether duplicate config keys inside a plugin should be rejected like duplicate capabilities.
- [ ] 2.5 Decide whether manifest schema versioning is required before public plugin package compatibility is promised.
