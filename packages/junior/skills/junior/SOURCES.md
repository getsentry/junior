# Junior Extension Skill Sources

Last updated: 2026-05-07

## Sources

| Source                                                          | Use                                               |
| --------------------------------------------------------------- | ------------------------------------------------- |
| `AGENTS.md`                                                     | repo validation and contribution rules            |
| `packages/junior-plugin-api/README.md`                          | plugin registration and public extension contract |
| `packages/junior/src/chat/plugins/README.md`                    | host discovery and runtime ownership              |
| `packages/junior/src/chat/credentials/README.md`                | actor-bound provider credential injection         |
| `packages/docs/src/content/docs/extend/index.md`                | public plugin setup                               |
| `packages/docs/src/content/docs/concepts/skills-and-plugins.md` | mental model                                      |
| `packages/docs/src/content/docs/cli/check.md`                   | app validation                                    |
| `packages/junior/src/chat/skills.ts`                            | skill parser/discovery/runtime boundary           |
| `packages/junior/src/chat/plugins/manifest.ts`                  | manifest parser                                   |
| `packages/junior/src/chat/plugins/package-discovery.ts`         | packaged plugin discovery                         |
| `packages/junior/src/cli/check.ts`                              | `junior check` behavior                           |
| `packages/junior/scripts/check-skills.mjs`                      | repo skill validation                             |
| `packages/junior-*` and `apps/example`                          | working examples                                  |

## Decisions

| Decision                                                                  | Status   |
| ------------------------------------------------------------------------- | -------- |
| Skill name/path: `packages/junior/skills/junior`                          | adopted  |
| Shape: reference-backed router                                            | adopted  |
| Central rule: `SKILL.md` describes behavior; `plugin.yaml` owns authority | adopted  |
| Examples stay in a reference, not `SKILL.md`                              | adopted  |
| No new scripts                                                            | adopted  |
| Distribution as packaged plugin                                           | deferred |

## Coverage

- provenance: complete
- placement/discovery: complete
- skill authoring: complete
- manifest schema: complete
- runtime authority: complete
- packaging: complete
- validation/troubleshooting: complete
- examples: happy path, robust variant, anti-pattern

## Gaps

- No standalone public command validates packaged root `plugin.yaml`; use runtime loading or parser tests.
- Update when parsers, discovery, `junior check`, or packaged plugin loading changes.

## Changelog

- 2026-05-07: Created and renamed to `junior`.
