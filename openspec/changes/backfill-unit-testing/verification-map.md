# Unit Testing Verification Map

| Spec Area                 | Existing Coverage                                      | Layer   | Files                              | Status | Notes                                     |
| ------------------------- | ------------------------------------------------------ | ------- | ---------------------------------- | ------ | ----------------------------------------- |
| Unit runner config        | node Vitest config includes tests                      | Config  | `packages/junior/vitest.config.ts` | keep   | Unit and integration share runner config. |
| Parser/validator examples | skill frontmatter, plugin manifests, config validation | Unit    | `packages/junior/tests/unit/**`    | keep   | Good examples of local invariants.        |
| Narrow dependency stubs   | command runner/registry/dependency resolver stubs      | Unit    | representative unit tests          | keep   | Allowed when one boundary is mocked.      |
| Over-mocked workflows     | broad runtime seam tests                               | Review  | some legacy unit tests             | gap    | Migrate when touched.                     |
| Focused verification      | single-file Vitest command                             | Command | AGENTS.md file-scoped command      | keep   | Use when unit files change.               |
