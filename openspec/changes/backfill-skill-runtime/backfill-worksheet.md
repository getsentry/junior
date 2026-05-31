# Backfill Worksheet: `skill-runtime`

## Scope

- Capability: Skill runtime
- Change: `backfill-skill-runtime`
- Owner: spec backfill program
- Status: draft
- Canonical target: `openspec/specs/skill-runtime/spec.md` after review

## Current-Source Inventory

### Existing Specs And Policies

- `specs/agent-prompt.md`: owns prompt guidance for available/loadable skills.
- `specs/tool-execution.md`: owns generic tool result/error semantics for `loadSkill`.
- `specs/sandbox-tools.md`: owns sandbox workspace tools; skill file sandbox is separate and scoped to skill roots.
- `specs/plugin-runtime.md`: owns plugin discovery and runtime setup.
- `specs/mcp-tool-runtime.md`: owns MCP dynamic tool search/call after a provider-backed skill is active.
- `specs/testing.md` and `specs/eval-testing.md`: own layer boundaries.

### Code Paths

- `packages/junior/src/chat/skills.ts`: frontmatter parsing, discovery, cache, invocation parsing, plugin ownership, runtime boundary injection, and skill body loading.
- `packages/junior/src/chat/tools/skill/load-skill.ts`: model-callable skill loading result and active skill hook.
- `packages/junior/src/chat/sandbox/skill-sandbox.ts`: active skill state, allowed-tools filtering, skill-scoped file list/read, traversal prevention.
- `packages/junior/src/chat/sandbox/skill-sync.ts`: copies current skills/reference files into sandbox contexts.
- `packages/junior/src/chat/respond.ts`: integrates available skills, loaded skills, skill sandbox, and MCP provider activation.

### Tests And Evals

- Unit:
  - `packages/junior/tests/unit/skills/skill-frontmatter.test.ts`
  - `packages/junior/tests/unit/skills/skills.test.ts`
  - `packages/junior/tests/unit/skills/load-skill-tool.test.ts`
  - `packages/junior/tests/unit/skills/skill-sandbox.test.ts`
  - `packages/junior/tests/unit/skills-plugin-provider.test.ts`
- Evals:
  - `packages/junior-evals/evals/core/skill-infra.eval.ts`
  - `packages/junior-evals/evals/core/skill-invocation-control.eval.ts`
  - Provider-specific skill workflow evals under `github/` and `sentry/`.

## Prior Art

- Agent Skills use a directory with `SKILL.md` YAML frontmatter plus markdown instructions.
- Prior art emphasizes progressive disclosure: metadata is discovered cheaply; full skill bodies and reference files are loaded only when relevant.
- Bundled references/scripts are supporting resources and should be accessed on demand, not loaded globally.

Sources:

- Anthropic Agent Skills engineering blog: https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills
- MCP tutorial using SKILL.md plus references: https://modelcontextprotocol.io/tutorials/building-mcp-with-llms

## Implemented Behavior

- Behavior that code currently enforces:
  - SKILL.md frontmatter requires valid name and description.
  - Descriptions with angle brackets and deprecated `requires-capabilities`/`uses-config` are rejected.
  - Discovery scans additional roots, environment roots, default roots, and plugin skill roots with dedupe/cache.
  - Invalid skill directories are skipped with warnings.
  - Slash commands invoke available skills.
  - `disable-model-invocation` skills can be invoked by explicit "use/run/load/call/invoke" language and are not invoked by incidental mentions.
  - `loadSkill` returns sandbox path guidance and full instructions.
  - Plugin-owned loaded skills receive runtime-boundary text and provider metadata.
  - Skill file sandbox blocks absolute/traversal paths and bounds list/read output.
  - `allowed-tools` filters exact runtime tool names.
- Behavior that tests currently verify:
  - Frontmatter validity/invalidity, deprecated field rejection, and disable-model-invocation parsing.
  - Skill discovery from configured dirs and plugin roots.
  - Skill invocation parsing and negated use.
  - Plugin skill provider ownership and runtime boundary injection.
  - `loadSkill` output shape and unknown skill result.
  - Skill file sandbox traversal blocking and allowed-tools exact filtering.
  - Evals cover slash skill invocation, repeated skill use ordering, working directory, source-backed auto-selection, explicit user-callable skill use, and refusal to auto-select disabled skills.
- Behavior that appears accidental or weakly enforced:
  - Unknown skill returns `ok:false` rather than an expected tool error.
  - `allowed-tools` ignores common portable pattern forms.
  - Discovery precedence and short TTL cache behavior may not have focused tests.
  - Exact interaction between preloaded skills and model auto-selection is prompt/eval dependent.

## Intended Behavior

- Product/runtime behavior that should be normative:
  - Discover metadata without prompt bloat.
  - Load full skill bodies only on demand.
  - Keep plugin manifests authoritative for runtime setup.
  - Scope skill file access to active/explicit skill directory.
  - Support explicit slash and named user-callable invocation.
  - Verify skill selection/application in evals.
- Behavior that should remain implementation detail:
  - Exact cache TTL.
  - Exact warning log names.
  - Exact sandbox virtual path prefix beyond path guidance semantics.
  - Exact prompt wording that lists available skills.
- Behavior that should be non-goal:
  - MCP tool execution semantics.
  - Plugin credential/OAuth setup.
  - Running arbitrary skill scripts without sandbox/tool mediation.

## Undefined Behavior / Open Questions

| Question                                           | Evidence                                                                        | Options                                                           | Recommendation                                                  | Status |
| -------------------------------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------- | ------ |
| What exactly does `disable-model-invocation` mean? | Parser/evals treat explicit names as allowed but incidental auto-use forbidden. | Never model-loaded, explicit-only, or prompt-only hint.           | Specify explicit-only user-callable behavior.                   | open   |
| Should `allowed-tools` support patterns?           | Test expects exact names and ignores patterns.                                  | Exact only, portable pattern subset, or provider-specific syntax. | Keep exact until tool registry supports patterns intentionally. | open   |
| Should unknown skill be a tool error?              | `loadSkill` returns `ok:false`.                                                 | Keep as data, throw `ToolInputError`, or split.                   | Review in tool error audit.                                     | open   |
| Should discovery cache be normative?               | Current TTL is 5 seconds.                                                       | Exact TTL, configurable, or implementation detail.                | Leave implementation detail.                                    | open   |

## OpenSpec Requirements Draft

| Requirement                       | Scenarios                                | Source Evidence                | Notes                |
| --------------------------------- | ---------------------------------------- | ------------------------------ | -------------------- |
| Skill file format validation      | valid, mismatch, description, deprecated | `skills.ts`, frontmatter tests | Contract parser.     |
| Skill discovery                   | roots, duplicate, read failure, cache    | `discoverSkills`, tests        | Metadata only.       |
| Skill invocation parsing          | slash, unknown, explicit, negated        | parser tests/evals             | User-facing.         |
| Skill loading tool                | known, unknown, plugin-backed            | load-skill tests               | Full body on demand. |
| Plugin runtime boundary injection | plugin, conflict, mismatch               | plugin tests                   | Manifest authority.  |
| Skill-scoped file sandbox         | list, read, traversal, no active         | skill sandbox tests            | References.          |
| Skill allowed tool filtering      | none, exact, patterns                    | skill sandbox tests            | Exact names.         |
| Verification taxonomy             | unit, eval, plugin/MCP                   | testing/evals                  | Layer split.         |

## Migration Notes

- Canonical spec updates:
  - Add `skill-runtime` to index after acceptance.
  - Keep plugin/MCP execution details in later specs.
- Index/pointer updates:
  - Add to `specs/index.md` and root `AGENTS.md` known specs after acceptance.
- Superseded content:
  - Narrow prompt docs to high-level skill availability; detailed mechanics live here.
- Test/eval taxonomy changes:
  - Map skill evals to these requirements and split plugin/MCP-specific behavior to those specs.

## Validation Notes

- `openspec validate`: passed with `Change 'backfill-skill-runtime' is valid`.
- Targeted tests/evals: intentionally not run for this spec-only backfill; current tests were inventoried but not changed.
- Deferred verification: unknown skill error shape, allowed-tools pattern support, discovery precedence/cache coverage, and exact disabled-invocation semantics.
