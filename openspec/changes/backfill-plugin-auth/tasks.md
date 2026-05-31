## 1. Backfill

- [x] 1.1 Inventory plugin auth broker code, token helpers, scope helpers, registry routing, and tests.
- [x] 1.2 Review prior art for OAuth refresh-token grants and GitHub App installation tokens.
- [x] 1.3 Identify implemented behavior, intended behavior, undefined behavior, and verification ownership.
- [x] 1.4 Write OpenSpec requirements and scenarios for `plugin-auth`.
- [x] 1.5 Create verification map for current tests/evals and gaps.
- [x] 1.6 Validate OpenSpec change with `openspec validate`.

## 2. Deferred Follow-Up

- [ ] 2.1 Decide whether static env-token fallback is allowed in production for OAuth-capable providers.
- [ ] 2.2 Add direct tests for OAuth token request serialization and token response parsing.
- [ ] 2.3 Decide whether GitHub App installation tokens should be cached until provider expiry.
- [ ] 2.4 Review GitHub capability-to-permission mapping against all shipped GitHub provider capabilities.
- [ ] 2.5 Decide whether literal static API header values should be restricted at manifest validation time.
