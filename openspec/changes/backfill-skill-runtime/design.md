# Design: `skill-runtime`

## Scope

`skill-runtime` owns discovery and loading of SKILL.md-based instructions and skill-scoped auxiliary files. It starts when Junior scans configured skill roots and ends when a loaded skill body, active skill state, and skill-scoped file access are available to the agent/tool runtime.

It does not own the concrete behavior of MCP provider tools, plugin credential issuance, or the agent's natural-language quality when applying skill instructions.

## Prior Art

Agent Skills prior art uses a directory with `SKILL.md` frontmatter for cheap discovery, full markdown body for on-demand instructions, and optional bundled resources read only when needed. The name and description are the critical trigger metadata; bundled scripts/references are supporting material, not automatically executed.

Sources:

- Anthropic engineering blog on Agent Skills: https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills
- MCP tutorial describing skills with `SKILL.md` and references: https://modelcontextprotocol.io/tutorials/building-mcp-with-llms

## Design Decisions

### Discover metadata cheaply, load bodies on demand

Junior should expose available skill names/descriptions without injecting every skill body into the prompt. Full skill instructions load only via explicit invocation or model tool call.

### Skill frontmatter is constrained

Skill name, description, and optional local metadata must be validated. Deprecated fields such as `requires-capabilities` and `uses-config` are rejected because plugin manifests now own credentials/config/runtime setup.

### Plugin manifests own runtime setup

When a skill is plugin-owned, Junior prepends a runtime-boundary notice saying the plugin manifest controls MCP, credentials, config keys, runtime packages, and postinstall steps. Skill prose cannot install or repair provider runtime setup.

### User-callable skill controls are explicit

Slash commands can invoke skills directly. Skills marked `disable-model-invocation` are not auto-selected merely because their domain matches, but users can explicitly ask to use/load/run that skill by name.

### Skill file access is scoped to active skill directory

Skill references and scripts are read through `SkillSandbox`, which prevents absolute paths and traversal outside the skill directory and bounds file size/output.

## Risks

- Auto-selection behavior is partly prompt/model-dependent and needs eval coverage rather than only unit tests.
- `allowed-tools` currently filters exact runtime tool names only; portability patterns such as `Bash(git:*)` are ignored.
- Unknown skill and some skill file errors currently return `{ ok:false }` or generic thrown errors, which may need alignment with `tool-execution`.
- Discovery cache may hide filesystem changes briefly by design.

## Open Questions

1. Should `disable-model-invocation` mean "never auto-load" or only "do not parse natural language explicit names without loadSkill"?
2. Should `allowed-tools` support portable patterns or stay exact runtime tool names?
3. Should unknown skill be an expected thrown `ToolInputError` rather than `ok:false` result?
4. Should skill discovery cache TTL be configurable or remain a small implementation detail?
